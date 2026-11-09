package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/MoeForge/moego/ojson"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	log "github.com/sirupsen/logrus"
)

const (
	codexOpenAIEmbeddingSourceFormat = "openai-embedding"
	codexEmbeddingsPath              = "/v1/embeddings"
	codexEmbeddingsSuffix            = "/embeddings"
)

func isCodexOpenAIEmbeddingsRequest(opts cliproxyexecutor.Options) bool {
	if strings.EqualFold(strings.TrimSpace(opts.SourceFormat.String()), codexOpenAIEmbeddingSourceFormat) {
		return true
	}
	return codexIsEmbeddingsEndpointPath(helps.PayloadRequestPath(opts))
}

func codexIsEmbeddingsEndpointPath(path string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	if path == codexEmbeddingsPath || path == codexEmbeddingsSuffix {
		return true
	}
	return strings.HasSuffix(path, codexEmbeddingsPath) || strings.HasSuffix(path, codexEmbeddingsSuffix)
}

func codexEmbeddingsBearerToken(ctx context.Context, auth *cliproxyauth.Auth, headers http.Header) (string, error) {
	if tok := strings.TrimSpace(codexSIWCAccessToken(auth)); tok != "" {
		return tok, nil
	}
	apiKey, _ := codexCredsForRequest(ctx, auth, headers)
	if tok := strings.TrimSpace(apiKey); tok != "" {
		return tok, nil
	}
	return "", statusErr{
		code: http.StatusUnauthorized,
		msg:  "codex executor: embeddings require a Codex SIWC token or OpenAI API key on the linked account",
	}
}

func (e *CodexExecutor) executeOpenAIEmbeddings(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (resp cliproxyexecutor.Response, err error) {
	ctx = cliproxyauth.WithCodexClientRequest(ctx, true)
	baseModel := thinking.ParseSuffix(req.Model).ModelName
	if strings.TrimSpace(baseModel) == "" {
		baseModel = strings.TrimSpace(ojson.GetBytesNoCopy(req.Payload, "model").String())
	}
	if strings.TrimSpace(baseModel) == "" {
		return resp, statusErr{code: http.StatusBadRequest, msg: "codex executor: embeddings model is required"}
	}

	token, errToken := codexEmbeddingsBearerToken(ctx, auth, opts.Headers)
	if errToken != nil {
		return resp, errToken
	}

	body := req.Payload
	if len(body) == 0 {
		return resp, statusErr{code: http.StatusBadRequest, msg: "codex executor: embeddings body is required"}
	}
	doc := ojson.NewDoc(body)
	helps.SetStringIfDifferentDoc(doc, "model", baseModel)
	body = doc.Bytes()

	reporter := helps.NewExecutorUsageReporter(ctx, e, baseModel, auth)
	defer reporter.TrackFailure(ctx, &err)

	url := strings.TrimSuffix(defaultOpenAISIWCBaseURL, "/") + codexEmbeddingsSuffix
	httpReq, body, errCache := e.cacheHelper(ctx, sdktranslator.FromString(codexOpenAIEmbeddingSourceFormat), url, req, body, auth, opts.Headers)
	if errCache != nil {
		return resp, errCache
	}
	payloadOpts := opts
	payloadOpts.SourceFormat = sdktranslator.FromString(codexOpenAIEmbeddingSourceFormat)
	ctx = helps.WithPayloadFinalizer(ctx, helps.NewPayloadFinalizer(e.cfg, e.Identifier(), baseModel, "openai", "", body, req, payloadOpts))
	body, _, errPrepare := helps.ApplyMediaPayloadConfig(e.cfg, e.Identifier(), baseModel, "openai", body, "application/json", req, payloadOpts)
	if errPrepare != nil {
		return resp, errPrepare
	}
	httpReq.Body = io.NopCloser(bytes.NewReader(body))
	httpReq.ContentLength = int64(len(body))
	httpReq.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	httpReq.Header.Del("Content-Encoding")

	prepareHeaders := func(request *http.Request) {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("User-Agent", codexSIWCUserAgent(e.cfg))
		applyModelHeaderOverrides(request.Header, baseModel)
		alignCodexContentEncoding(request)
	}
	prepareHeaders(httpReq)

	httpClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)
	httpClient = reporter.TrackHTTPClient(httpClient)
	httpResp, errDo := doCodexRequest(httpClient, httpReq, body, prepareHeaders, nil)
	if errDo != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, errDo)
		return resp, errDo
	}
	defer func() {
		if errClose := httpResp.Body.Close(); errClose != nil {
			log.Errorf("codex executor: close embeddings response body error: %v", errClose)
		}
	}()

	helps.RecordAPIResponseMetadata(ctx, e.cfg, httpResp.StatusCode, httpResp.Header.Clone())
	data, errRead := io.ReadAll(httpResp.Body)
	if errRead != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, errRead)
		return resp, errRead
	}
	helps.AppendAPIResponseChunk(ctx, e.cfg, data)
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		helps.LogWithRequestID(ctx).Debugf("embeddings request error, status: %d, message: %s", httpResp.StatusCode, helps.SummarizeErrorBody(httpResp.Header.Get("Content-Type"), data))
		msg := strings.TrimSpace(helps.SummarizeErrorBody(httpResp.Header.Get("Content-Type"), data))
		if msg == "" {
			msg = fmt.Sprintf("upstream embeddings HTTP %d", httpResp.StatusCode)
		}
		err = newCodexStatusErrWithHeadersAndCooling(httpResp.StatusCode, httpResp.Header, data, e.modelLevelCooling())
		if httpResp.StatusCode == http.StatusUnauthorized || httpResp.StatusCode == http.StatusForbidden {
			err = statusErr{
				code: httpResp.StatusCode,
				msg:  msg + " (Codex login may not include Platform embeddings entitlement)",
			}
		}
		return resp, err
	}

	reporter.EnsurePublished(ctx)
	return cliproxyexecutor.Response{Payload: data, Headers: httpResp.Header.Clone()}, nil
}
