// Package rivetsink forwards captured proxy traffic to Rivet's local ingest API.
// Credentials are never sent — only request/response bodies and metadata.
package rivetsink

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/logging"
)

type sinkError string

func (e sinkError) Error() string { return string(e) }

const errNoFileBodySource sinkError = "rivetsink: inner logger does not support file body sources"

// Wrapper dual-writes to an inner RequestLogger and posts events to Rivet.
// IsEnabled is always true while ingest is configured so middleware keeps
// capturing traffic even when on-disk request-log is disabled.
type Wrapper struct {
	inner  logging.RequestLogger
	sender *queueSender
}

type trafficEvent struct {
	ID           string  `json:"id"`
	Ts           string  `json:"ts"`
	Provider     string  `json:"provider"`
	AccountLabel *string `json:"account_label"`
	Model        *string `json:"model"`
	SessionID    *string `json:"session_id"`
	ProjectID    *string `json:"project_id"`
	RequestID    *string `json:"request_id"`
	Role         string  `json:"role"`
	Content      *string `json:"content"`
	TokensIn     uint32  `json:"tokens_in"`
	TokensOut    uint32  `json:"tokens_out"`
	LatencyMs    *uint64 `json:"latency_ms"`
	StatusCode   *uint16 `json:"status_code"`
	BodyRef      *string `json:"body_ref"`
}

type parsedMeta struct {
	Model     string
	SessionID string
	ProjectID string
	Role      string
	TokensIn  uint32
	TokensOut uint32
}

// Wrap returns logger unchanged unless RIVET_INGEST_URL is set.
func Wrap(inner logging.RequestLogger) logging.RequestLogger {
	url := strings.TrimSpace(os.Getenv("RIVET_INGEST_URL"))
	if url == "" || inner == nil {
		return inner
	}
	return &Wrapper{
		inner:  inner,
		sender: newQueueSender(url, strings.TrimSpace(os.Getenv("RIVET_INGEST_KEY"))),
	}
}

// IsEnabled reports capture as on for Rivet even if the file logger is off.
func (w *Wrapper) IsEnabled() bool { return true }

func (w *Wrapper) SetEnabled(enabled bool) {
	if setter, ok := w.inner.(interface{ SetEnabled(bool) }); ok {
		setter.SetEnabled(enabled)
	}
}

func (w *Wrapper) SetHomeEnabled(enabled bool) {
	if setter, ok := w.inner.(interface{ SetHomeEnabled(bool) }); ok {
		setter.SetHomeEnabled(enabled)
	}
}

func (w *Wrapper) SetErrorLogsMaxFiles(maxFiles int) {
	if setter, ok := w.inner.(interface{ SetErrorLogsMaxFiles(int) }); ok {
		setter.SetErrorLogsMaxFiles(maxFiles)
	}
}

func (w *Wrapper) NewFileBodySource(prefix string) (*logging.FileBodySource, error) {
	factory, ok := w.inner.(interface {
		NewFileBodySource(string) (*logging.FileBodySource, error)
	})
	if !ok {
		return nil, errNoFileBodySource
	}
	return factory.NewFileBodySource(prefix)
}

// forceForInner restores CPA's error-only file logging. Middleware only sets
// force when !logger.IsEnabled(), but this wrapper stays enabled for Rivet.
func (w *Wrapper) forceForInner(force bool, statusCode int) bool {
	if force {
		return true
	}
	return w.inner != nil && !w.inner.IsEnabled() && statusCode >= 400
}

func (w *Wrapper) logInnerWithForce(url, method string, requestHeaders map[string][]string, body []byte, statusCode int, responseHeaders map[string][]string, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline []byte, apiResponseErrors []*interfaces.ErrorMessage, force bool, requestID string, requestTimestamp, apiResponseTimestamp time.Time) error {
	force = w.forceForInner(force, statusCode)
	if withOpts, ok := w.inner.(interface {
		LogRequestWithOptions(string, string, map[string][]string, []byte, int, map[string][]string, []byte, []byte, []byte, []byte, []byte, []*interfaces.ErrorMessage, bool, string, time.Time, time.Time) error
	}); ok {
		return withOpts.LogRequestWithOptions(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline, apiResponseErrors, force, requestID, requestTimestamp, apiResponseTimestamp)
	}
	return w.inner.LogRequest(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline, apiResponseErrors, requestID, requestTimestamp, apiResponseTimestamp)
}

func (w *Wrapper) LogRequest(url, method string, requestHeaders map[string][]string, body []byte, statusCode int, responseHeaders map[string][]string, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline []byte, apiResponseErrors []*interfaces.ErrorMessage, requestID string, requestTimestamp, apiResponseTimestamp time.Time) error {
	err := w.logInnerWithForce(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline, apiResponseErrors, false, requestID, requestTimestamp, apiResponseTimestamp)
	w.forward(url, requestHeaders, body, response, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequest)
	return err
}

// LogRequestWithOptions preserves forced error-log writes on the inner logger.
func (w *Wrapper) LogRequestWithOptions(url, method string, requestHeaders map[string][]string, body []byte, statusCode int, responseHeaders map[string][]string, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline []byte, apiResponseErrors []*interfaces.ErrorMessage, force bool, requestID string, requestTimestamp, apiResponseTimestamp time.Time) error {
	err := w.logInnerWithForce(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline, apiResponseErrors, force, requestID, requestTimestamp, apiResponseTimestamp)
	w.forward(url, requestHeaders, body, response, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequest)
	return err
}

func mergeAPIRequestCapture(apiRequest []byte, source *logging.FileBodySource) []byte {
	if source == nil || !source.HasPayload() {
		return apiRequest
	}
	fromSrc, err := source.Bytes()
	if err != nil || len(fromSrc) == 0 {
		return apiRequest
	}
	if len(apiRequest) == 0 {
		return fromSrc
	}
	out := make([]byte, 0, len(apiRequest)+len(fromSrc)+2)
	out = append(out, apiRequest...)
	if !bytes.HasSuffix(apiRequest, []byte("\n")) {
		out = append(out, '\n')
	}
	out = append(out, '\n')
	out = append(out, fromSrc...)
	return out
}

func (w *Wrapper) LogRequestWithOptionsAndSources(url, method string, requestHeaders map[string][]string, body []byte, statusCode int, responseHeaders map[string][]string, response, websocketTimeline []byte, websocketTimelineSource *logging.FileBodySource, apiRequest, apiResponse, apiWebsocketTimeline []byte, apiWebsocketTimelineSource *logging.FileBodySource, apiResponseErrors []*interfaces.ErrorMessage, force bool, requestID string, requestTimestamp, apiResponseTimestamp time.Time) error {
	w.forward(url, requestHeaders, body, response, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequest)
	force = w.forceForInner(force, statusCode)
	if withOpts, ok := w.inner.(interface {
		LogRequestWithOptionsAndSources(string, string, map[string][]string, []byte, int, map[string][]string, []byte, []byte, *logging.FileBodySource, []byte, []byte, []byte, *logging.FileBodySource, []*interfaces.ErrorMessage, bool, string, time.Time, time.Time) error
	}); ok {
		return withOpts.LogRequestWithOptionsAndSources(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, websocketTimelineSource, apiRequest, apiResponse, apiWebsocketTimeline, apiWebsocketTimelineSource, apiResponseErrors, force, requestID, requestTimestamp, apiResponseTimestamp)
	}
	return w.logInnerWithForce(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline, apiResponseErrors, force, requestID, requestTimestamp, apiResponseTimestamp)
}

func (w *Wrapper) LogRequestWithOptionsAndAllSources(url, method string, requestHeaders map[string][]string, body []byte, statusCode int, responseHeaders map[string][]string, response, websocketTimeline []byte, websocketTimelineSource *logging.FileBodySource, apiRequest []byte, apiRequestSource *logging.FileBodySource, apiResponse []byte, apiResponseSource *logging.FileBodySource, apiWebsocketTimeline []byte, apiWebsocketTimelineSource *logging.FileBodySource, apiResponseErrors []*interfaces.ErrorMessage, force bool, requestID string, requestTimestamp, apiResponseTimestamp time.Time) error {
	// Read source-backed upstream metadata before the inner logger cleans it up.
	apiRequestForRivet := mergeAPIRequestCapture(apiRequest, apiRequestSource)
	w.forward(url, requestHeaders, body, response, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequestForRivet)
	force = w.forceForInner(force, statusCode)
	if withOpts, ok := w.inner.(interface {
		LogRequestWithOptionsAndAllSources(string, string, map[string][]string, []byte, int, map[string][]string, []byte, []byte, *logging.FileBodySource, []byte, *logging.FileBodySource, []byte, *logging.FileBodySource, []byte, *logging.FileBodySource, []*interfaces.ErrorMessage, bool, string, time.Time, time.Time) error
	}); ok {
		return withOpts.LogRequestWithOptionsAndAllSources(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, websocketTimelineSource, apiRequest, apiRequestSource, apiResponse, apiResponseSource, apiWebsocketTimeline, apiWebsocketTimelineSource, apiResponseErrors, force, requestID, requestTimestamp, apiResponseTimestamp)
	}
	return w.logInnerWithForce(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequestForRivet, apiResponse, apiWebsocketTimeline, apiResponseErrors, force, requestID, requestTimestamp, apiResponseTimestamp)
}

func (w *Wrapper) LogStreamingRequest(url, method string, headers map[string][]string, body []byte, requestID string) (logging.StreamingLogWriter, error) {
	writer, err := w.inner.LogStreamingRequest(url, method, headers, body, requestID)
	if err != nil {
		return writer, err
	}
	return &streamWrapper{
		inner:     writer,
		parent:    w,
		url:       url,
		headers:   headers,
		reqBody:   append([]byte(nil), body...),
		requestID: requestID,
		started:   time.Now(),
		provider:  inferProvider(url, body),
	}, nil
}

type streamWrapper struct {
	inner     logging.StreamingLogWriter
	parent    *Wrapper
	url       string
	headers   map[string][]string
	reqBody   []byte
	requestID string
	started   time.Time
	provider  string

	mu       sync.Mutex
	head     []byte
	tail     []byte
	apiReq   []byte
	apiResp  []byte
	apiErrs  []*interfaces.ErrorMessage
	status   int
	closed   bool
	finished time.Time
	// Usage accumulated from every chunk, independent of the text buffer.
	tokensIn  uint32
	tokensOut uint32
	model     string
	partial   string // incomplete SSE JSON across chunk boundaries
}

// appendHeadTail keeps the first headBytes and last tailBytes of a stream so
// long responses retain both the start (prompt context) and end (usage).
func appendHeadTail(head, tail *[]byte, chunk []byte, headBytes, tailBytes int) {
	if len(chunk) == 0 {
		return
	}
	if len(*head) < headBytes {
		need := headBytes - len(*head)
		if len(chunk) <= need {
			*head = append(*head, chunk...)
			return
		}
		*head = append(*head, chunk[:need]...)
		chunk = chunk[need:]
	}
	*tail = append(*tail, chunk...)
	if len(*tail) > tailBytes {
		*tail = append([]byte(nil), (*tail)[len(*tail)-tailBytes:]...)
	}
}

func (s *streamWrapper) WriteChunkAsync(chunk []byte) {
	s.inner.WriteChunkAsync(chunk)
	s.mu.Lock()
	defer s.mu.Unlock()
	appendHeadTail(&s.head, &s.tail, chunk, 48*1024, 48*1024)
	// Parse complete SSE lines; keep a partial trailing frame across writes.
	buf := s.partial + string(chunk)
	lines := strings.Split(buf, "\n")
	if !strings.HasSuffix(buf, "\n") && len(lines) > 0 {
		s.partial = lines[len(lines)-1]
		lines = lines[:len(lines)-1]
	} else {
		s.partial = ""
	}
	meta := parsedMeta{TokensIn: s.tokensIn, TokensOut: s.tokensOut, Model: s.model}
	parseStreamMeta(&meta, s.provider, strings.Join(lines, "\n"))
	s.tokensIn = meta.TokensIn
	s.tokensOut = meta.TokensOut
	if meta.Model != "" {
		s.model = meta.Model
	}
}

func (s *streamWrapper) WriteStatus(status int, headers map[string][]string) error {
	s.mu.Lock()
	s.status = status
	s.mu.Unlock()
	return s.inner.WriteStatus(status, headers)
}

func (s *streamWrapper) WriteAPIRequest(apiRequest []byte) error {
	s.mu.Lock()
	s.apiReq = append([]byte(nil), apiRequest...)
	// Prefer credential-pool identity once the executor records the upstream attempt.
	if p := inferProviderFromCapture(s.url, s.reqBody, s.apiReq); p != "" {
		s.provider = p
	}
	s.mu.Unlock()
	return s.inner.WriteAPIRequest(apiRequest)
}

func (s *streamWrapper) WriteAPIResponse(apiResponse []byte) error {
	s.mu.Lock()
	s.apiResp = append([]byte(nil), apiResponse...)
	if len(s.apiResp) > 96*1024 {
		s.apiResp = s.apiResp[:96*1024]
	}
	s.mu.Unlock()
	return s.inner.WriteAPIResponse(apiResponse)
}

func (s *streamWrapper) WriteAPIWebsocketTimeline(apiWebsocketTimeline []byte) error {
	return s.inner.WriteAPIWebsocketTimeline(apiWebsocketTimeline)
}

func (s *streamWrapper) WriteAPIResponseErrors(errors []*interfaces.ErrorMessage) error {
	s.mu.Lock()
	s.apiErrs = append([]*interfaces.ErrorMessage(nil), errors...)
	s.mu.Unlock()
	return s.inner.WriteAPIResponseErrors(errors)
}

func (s *streamWrapper) SetFirstChunkTimestamp(timestamp time.Time) {
	s.inner.SetFirstChunkTimestamp(timestamp)
}

func (s *streamWrapper) Close() error {
	err := s.inner.Close()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return err
	}
	s.closed = true
	s.finished = time.Now()
	resp := append([]byte(nil), s.head...)
	if len(s.tail) > 0 {
		if len(s.head) > 0 {
			resp = append(resp, []byte("\n…\n")...)
		}
		resp = append(resp, s.tail...)
	}
	if len(s.apiResp) > 0 {
		resp = append(resp, '\n')
		resp = append(resp, s.apiResp...)
	}
	status := s.status
	started := s.started
	finished := s.finished
	tokensIn := s.tokensIn
	tokensOut := s.tokensOut
	model := s.model
	apiReq := append([]byte(nil), s.apiReq...)
	apiErrs := append([]*interfaces.ErrorMessage(nil), s.apiErrs...)
	headers := s.headers
	reqBody := s.reqBody
	requestID := s.requestID
	url := s.url
	provider := inferProviderFromCapture(s.url, s.reqBody, s.apiReq)
	if provider == "" {
		provider = s.provider
	}
	s.mu.Unlock()

	s.parent.forwardStream(url, headers, reqBody, resp, status, requestID, started, finished, provider, tokensIn, tokensOut, model)
	// Inner streaming writer is often a no-op when request-log is off; force an error file.
	if s.parent.inner != nil && !s.parent.inner.IsEnabled() && (status >= 400 || len(apiErrs) > 0) {
		forceStatus := status
		if forceStatus < 400 {
			forceStatus = 500
		}
		_ = s.parent.logInnerWithForce(url, "POST", headers, reqBody, forceStatus, nil, resp, nil, apiReq, nil, nil, apiErrs, true, requestID, started, finished)
	}
	return err
}

func (w *Wrapper) forwardStream(url string, headers map[string][]string, reqBody, respBody []byte, statusCode int, requestID string, started, finished time.Time, provider string, tokensIn, tokensOut uint32, modelHint string) {
	if v := headerFirst(headers, "x-rivet-internal"); v != "" {
		return
	}
	meta := parseMeta(provider, headers, reqBody, respBody)
	if tokensIn > 0 {
		meta.TokensIn = tokensIn
	}
	if tokensOut > 0 {
		meta.TokensOut = tokensOut
	}
	if modelHint != "" && meta.Model == "" {
		meta.Model = modelHint
	}
	w.emit(url, headers, reqBody, respBody, statusCode, requestID, started, finished, provider, meta)
}

func (w *Wrapper) forward(url string, headers map[string][]string, reqBody, respBody []byte, statusCode int, requestID string, started, finished time.Time, apiRequest []byte) {
	if v := headerFirst(headers, "x-rivet-internal"); v != "" {
		return
	}
	provider := inferProviderFromCapture(url, reqBody, apiRequest)
	meta := parseMeta(provider, headers, reqBody, respBody)
	w.emit(url, headers, reqBody, respBody, statusCode, requestID, started, finished, provider, meta)
}

func (w *Wrapper) emit(url string, headers map[string][]string, reqBody, respBody []byte, statusCode int, requestID string, started, finished time.Time, provider string, meta parsedMeta) {
	// Truncate request only; response may already be a head+tail assembly — keep its ending.
	reqPart := truncate(string(reqBody), 48*1024)
	content := reqPart
	if len(respBody) > 0 {
		respPart := string(respBody)
		if len(respPart) > 96*1024 {
			// Prefer keeping the end of a long response (usage / final text).
			respPart = "…\n" + respPart[len(respPart)-96*1024:]
		}
		content = reqPart + "\n---\n" + respPart
	}
	content = redactSecrets(content)

	var latency *uint64
	if !started.IsZero() && !finished.IsZero() && finished.After(started) {
		ms := uint64(finished.Sub(started).Milliseconds())
		latency = &ms
	}
	var status *uint16
	if statusCode > 0 {
		s := uint16(statusCode)
		status = &s
	}
	var rid *string
	if requestID != "" {
		rid = &requestID
	}
	var model, sessionID, projectID, accountLabel *string
	if meta.Model != "" {
		model = &meta.Model
	}
	if meta.SessionID != "" {
		sessionID = &meta.SessionID
	}
	if meta.ProjectID != "" {
		projectID = &meta.ProjectID
	}
	if v := headerFirst(headers, "x-rivet-account", "x-account-label", "x-account-email", "x-goog-authenticated-user-email"); v != "" {
		accountLabel = &v
	}
	role := meta.Role
	if role == "" {
		role = "unknown"
	}
	// Prefer model-derived provider when URL path is ambiguous (OpenAI-compat).
	if provider == "codex" || provider == "other" {
		if refined := providerFromModel(meta.Model); refined != "" {
			provider = refined
		}
	}

	evt := trafficEvent{
		ID:           uuid.NewString(),
		Ts:           time.Now().UTC().Format(time.RFC3339Nano),
		Provider:     provider,
		AccountLabel: accountLabel,
		Model:        model,
		SessionID:    sessionID,
		ProjectID:    projectID,
		RequestID:    rid,
		Role:         role,
		Content:      &content,
		TokensIn:     meta.TokensIn,
		TokensOut:    meta.TokensOut,
		LatencyMs:    latency,
		StatusCode:   status,
	}
	payload, err := json.Marshal(evt)
	if err != nil {
		return
	}
	_ = url // retained for future request-path tagging
	if w.sender != nil {
		w.sender.enqueue(payload)
	}
}

func providerFromModel(model string) string {
	m := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(m, "claude"):
		return "claude"
	case strings.Contains(m, "grok"):
		return "xai"
	case strings.Contains(m, "kimi") || strings.Contains(m, "moonshot"):
		return "kimi"
	case strings.Contains(m, "gemini"):
		return "gemini"
	case strings.Contains(m, "llama"):
		return "meta"
	case strings.Contains(m, "gpt"), strings.Contains(m, "codex"),
		m == "o1", strings.HasPrefix(m, "o1-"),
		m == "o3", strings.HasPrefix(m, "o3-"),
		m == "o4", strings.HasPrefix(m, "o4-"):
		return "codex"
	default:
		return ""
	}
}

// inferProviderFromCapture prefers the selected credential pool recorded in the
// upstream API REQUEST section (Auth: provider=… / Upstream URL: …). Client
// paths like /v1/messages alone cannot distinguish Vertex vs Claude pools.
func inferProviderFromCapture(clientURL string, reqBody, apiRequest []byte) string {
	if p := providerFromAPIRequestAuth(apiRequest); p != "" {
		return p
	}
	if u := upstreamURLFromAPIRequest(apiRequest); u != "" {
		return inferProvider(u, reqBody)
	}
	return inferProvider(clientURL, reqBody)
}

func providerFromAPIRequestAuth(apiRequest []byte) string {
	if len(apiRequest) == 0 {
		return ""
	}
	// Prefer the *last* successful attempt's Auth line (failover → winning pool).
	// Only scan attempt header blocks — never the Body payload.
	var lastProvider, lastAuthID, lastUpstream string
	inHeaders := false
	curUpstream, curAuthID, curProvider := "", "", ""
	flush := func() {
		if curProvider != "" {
			lastProvider, lastAuthID, lastUpstream = curProvider, curAuthID, curUpstream
		}
		curUpstream, curAuthID, curProvider = "", "", ""
	}
	for _, raw := range strings.Split(string(apiRequest), "\n") {
		line := strings.TrimSpace(raw)
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "=== api request") {
			flush()
			inHeaders = true
			continue
		}
		if !inHeaders {
			continue
		}
		if lower == "body:" || strings.HasPrefix(lower, "body:") {
			flush()
			inHeaders = false
			continue
		}
		if strings.HasPrefix(line, "Upstream URL:") {
			curUpstream = strings.TrimSpace(strings.TrimPrefix(line, "Upstream URL:"))
			continue
		}
		if strings.HasPrefix(lower, "auth:") {
			curProvider = parseAuthField(line, "provider=")
			curAuthID = parseAuthField(line, "auth_id=")
		}
	}
	flush()
	if lastProvider == "" {
		return ""
	}
	p := normalizeCapturedProvider(lastProvider)
	// KimiExecutor always Identifies as "kimi"; disambiguate the kimi-ai pool.
	if p == "kimi" && isKimiAIPool(lastUpstream, lastAuthID) {
		return "kimi-ai"
	}
	return p
}

func parseAuthField(authLine, key string) string {
	lower := strings.ToLower(authLine)
	idx := strings.Index(lower, key)
	if idx < 0 {
		return ""
	}
	rest := authLine[idx+len(key):]
	if end := strings.IndexAny(rest, ", \t\r"); end >= 0 {
		rest = rest[:end]
	}
	return strings.TrimSpace(rest)
}

func isKimiAIPool(upstreamURL, authID string) bool {
	// kimi.com → "kimi" pool; kimi.ai → "kimi-ai" pool. Do not conflate.
	u := strings.ToLower(upstreamURL)
	id := strings.ToLower(authID)
	if strings.Contains(u, "kimi.com") {
		return false
	}
	return strings.Contains(u, "kimi.ai") ||
		strings.Contains(u, "kimi-ai") ||
		strings.Contains(id, "kimi-ai") ||
		strings.Contains(id, "kimi_ai")
}

func upstreamURLFromAPIRequest(apiRequest []byte) string {
	if len(apiRequest) == 0 {
		return ""
	}
	for _, line := range strings.Split(string(apiRequest), "\n") {
		line = strings.TrimSpace(line)
		const prefix = "Upstream URL:"
		if strings.HasPrefix(line, prefix) {
			u := strings.TrimSpace(strings.TrimPrefix(line, prefix))
			if u != "" && u != "<unknown>" {
				return u
			}
		}
	}
	return ""
}

func normalizeCapturedProvider(p string) string {
	switch p {
	case "anthropic":
		return "claude"
	case "openai", "chatgpt":
		return "codex"
	case "gemini-cli", "gemini_cli":
		return "gemini"
	default:
		return p
	}
}

func inferProvider(url string, reqBody []byte) string {
	u := strings.ToLower(url)
	// Account-backed multi-model routes: URL/route wins so Claude-on-Vertex
	// stays attributed to the Vertex pool (not "claude").
	switch {
	case strings.Contains(u, "antigravity") || strings.Contains(u, "cloudcode"):
		return "antigravity"
	case strings.Contains(u, "vertex") || strings.Contains(u, "aiplatform.googleapis"):
		return "vertex"
	case strings.Contains(u, "kimi.ai") || strings.Contains(u, "kimi-ai"):
		return "kimi-ai"
	case strings.Contains(u, "devin"):
		return "devin"
	}

	// OpenAI-compatible / unknown paths: model id disambiguates.
	modelHint := ""
	var req map[string]any
	if json.Unmarshal(reqBody, &req) == nil {
		if m, ok := req["model"].(string); ok {
			modelHint = strings.TrimSpace(m)
			if p := providerFromModel(m); p != "" {
				return p
			}
		}
	}
	switch {
	case strings.Contains(u, "anthropic") || strings.Contains(u, "/v1/messages"):
		return "claude"
	case strings.Contains(u, "kimi") || strings.Contains(u, "moonshot"):
		return "kimi"
	case strings.Contains(u, "x.ai") || strings.Contains(u, "/xai") || strings.Contains(u, "grok"):
		return "xai"
	case strings.Contains(u, "meta.com") || strings.Contains(u, "llama"):
		return "meta"
	case strings.Contains(u, "gemini") || strings.Contains(u, "generativelanguage.googleapis"):
		return "gemini"
	case strings.Contains(u, "openai") || strings.Contains(u, "/v1/responses") || strings.Contains(u, "/v1/chat/completions"):
		// Explicit unrecognized model must not inherit the openai-compat default.
		if modelHint != "" {
			return "other"
		}
		return "codex"
	}
	body := strings.ToLower(string(reqBody))
	switch {
	case strings.Contains(body, `"claude`) || (bytes.Contains(reqBody, []byte(`"messages"`)) && bytes.Contains(reqBody, []byte(`"max_tokens"`))):
		return "claude"
	case strings.Contains(body, "gpt-") || strings.Contains(body, "codex") || bytes.Contains(reqBody, []byte(`"input"`)):
		return "codex"
	case strings.Contains(body, "grok"):
		return "xai"
	case strings.Contains(body, "kimi") || strings.Contains(body, "moonshot"):
		return "kimi"
	case strings.Contains(body, "gemini"):
		return "gemini"
	case strings.Contains(body, "llama"):
		return "meta"
	}
	return "other"
}

func parseMeta(provider string, headers map[string][]string, reqBody, respBody []byte) parsedMeta {
	meta := parsedMeta{Role: "unknown"}
	if v := headerFirst(headers, "x-session-id", "session-id", "x-chat-id"); v != "" {
		meta.SessionID = v
	}
	if v := headerFirst(headers, "x-project-id", "project-id"); v != "" {
		meta.ProjectID = v
	}

	var req map[string]any
	_ = json.Unmarshal(reqBody, &req)
	if req != nil {
		if m, ok := req["model"].(string); ok && m != "" {
			meta.Model = m
		}
		if meta.SessionID == "" {
			if s, ok := req["session_id"].(string); ok {
				meta.SessionID = s
			}
		}
		if meta.ProjectID == "" {
			if s, ok := req["project_id"].(string); ok {
				meta.ProjectID = s
			} else if metaMap, ok := req["metadata"].(map[string]any); ok {
				if s, ok := metaMap["project_id"].(string); ok {
					meta.ProjectID = s
				}
				if s, ok := metaMap["session_id"].(string); ok && meta.SessionID == "" {
					meta.SessionID = s
				}
			}
		}
		meta.Role = inferRoleFromRequest(req)
	}

	// Non-stream JSON response.
	var resp map[string]any
	if json.Unmarshal(respBody, &resp) == nil && resp != nil {
		applyUsage(&meta, provider, resp)
		if meta.Model == "" {
			if m, ok := resp["model"].(string); ok {
				meta.Model = m
			}
		}
		if role := inferRoleFromResponse(resp); role != "unknown" {
			meta.Role = role
		}
	} else {
		// SSE / NDJSON stream — scan for usage and model.
		parseStreamMeta(&meta, provider, string(respBody))
	}
	return meta
}

func applyUsage(meta *parsedMeta, _provider string, obj map[string]any) {
	usage, _ := obj["usage"].(map[string]any)
	if usage == nil {
		// Gemini / Google Generative Language
		if um, ok := obj["usageMetadata"].(map[string]any); ok {
			usage = um
		}
	}
	if usage == nil {
		// OpenAI Responses streams nest usage under response.
		if resp, ok := obj["response"].(map[string]any); ok {
			applyUsage(meta, _provider, resp)
		}
		return
	}
	// Normalize Gemini field names into the OpenAI-shaped keys used below.
	if v := uintFrom(usage, "promptTokenCount"); v > 0 {
		if _, ok := usage["prompt_tokens"]; !ok {
			usage["prompt_tokens"] = float64(v)
		}
	}
	if v := uintFrom(usage, "candidatesTokenCount"); v > 0 {
		if _, ok := usage["completion_tokens"]; !ok {
			usage["completion_tokens"] = float64(v)
		}
	}
	// Gemini thinking tokens are billed/output-adjacent — fold into completion.
	if v := uintFrom(usage, "thoughtsTokenCount"); v > 0 {
		cur := uintFrom(usage, "completion_tokens")
		usage["completion_tokens"] = float64(cur + v)
	}
	if v := uintFrom(usage, "totalTokenCount"); v > 0 {
		if _, ok := usage["total_tokens"]; !ok {
			usage["total_tokens"] = float64(v)
		}
	}
	// Usage shape follows the *client/response* schema, not the credential pool.
	// Vertex/Antigravity serving Claude still emit Anthropic cache fields;
	// OpenAI-compat clients still emit prompt_tokens even when the pool is Claude.

	// Anthropic-shaped (incl. cache) — high-water across nested/repeated frames.
	in := uintFrom(usage, "input_tokens")
	cache := uintFrom(usage, "cache_creation_input_tokens") +
		uintFrom(usage, "cache_read_input_tokens")
	if frame := in + cache; frame > meta.TokensIn {
		meta.TokensIn = frame
	}
	if v := uintFrom(usage, "output_tokens"); v > meta.TokensOut {
		meta.TokensOut = v
	}

	// OpenAI / Codex / Responses — take the higher watermark so a Claude-shaped
	// frame is not clobbered by a smaller prompt_tokens on a nested envelope.
	if v := uintFrom(usage, "prompt_tokens"); v > meta.TokensIn {
		meta.TokensIn = v
	}
	if v := uintFrom(usage, "completion_tokens"); v > meta.TokensOut {
		meta.TokensOut = v
	}

	if meta.TokensIn == 0 && meta.TokensOut == 0 {
		if total := uintFrom(usage, "total_tokens"); total > 0 {
			meta.TokensIn = total
		}
	}
}

func parseStreamMeta(meta *parsedMeta, provider, raw string) {
	// SSE: data: {...}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "data: [DONE]" {
			continue
		}
		payload := line
		if strings.HasPrefix(payload, "data:") {
			payload = strings.TrimSpace(strings.TrimPrefix(payload, "data:"))
		}
		var obj map[string]any
		if json.Unmarshal([]byte(payload), &obj) != nil {
			continue
		}
		if meta.Model == "" {
			if m, ok := obj["model"].(string); ok {
				meta.Model = m
			}
		}
		// applyUsage already walks usage + nested response — do not re-apply.
		applyUsage(meta, provider, obj)
		if msg, ok := obj["message"].(map[string]any); ok {
			applyUsage(meta, provider, msg)
			if meta.Model == "" {
				if m, ok := msg["model"].(string); ok {
					meta.Model = m
				}
			}
		}
		if resp, ok := obj["response"].(map[string]any); ok {
			if meta.Model == "" {
				if m, ok := resp["model"].(string); ok {
					meta.Model = m
				}
			}
		}
		if role := inferRoleFromResponse(obj); role != "unknown" {
			meta.Role = role
		}
	}
}

func inferRoleFromRequest(req map[string]any) string {
	if msgs, ok := req["messages"].([]any); ok && len(msgs) > 0 {
		if last, ok := msgs[len(msgs)-1].(map[string]any); ok {
			if r, ok := last["role"].(string); ok {
				return normalizeRole(r)
			}
		}
		return "user"
	}
	if input, ok := req["input"]; ok {
		switch v := input.(type) {
		case string:
			if v != "" {
				return "user"
			}
		case []any:
			if len(v) > 0 {
				return "user"
			}
		}
	}
	return "unknown"
}

func inferRoleFromResponse(resp map[string]any) string {
	if r, ok := resp["role"].(string); ok {
		return normalizeRole(r)
	}
	if typ, ok := resp["type"].(string); ok {
		switch typ {
		case "message":
			return "assistant"
		case "response.completed", "response.output_item.done":
			return "assistant"
		}
	}
	if choices, ok := resp["choices"].([]any); ok && len(choices) > 0 {
		return "assistant"
	}
	if _, ok := resp["content"]; ok {
		if _, hasModel := resp["model"]; hasModel {
			return "assistant"
		}
	}
	return "unknown"
}

func normalizeRole(r string) string {
	switch strings.ToLower(strings.TrimSpace(r)) {
	case "system":
		return "system"
	case "user":
		return "user"
	case "assistant":
		return "assistant"
	case "tool", "function":
		return "tool"
	default:
		return "unknown"
	}
}

func uintFrom(m map[string]any, key string) uint32 {
	v, ok := m[key]
	if !ok || v == nil {
		return 0
	}
	switch n := v.(type) {
	case float64:
		if n < 0 {
			return 0
		}
		return uint32(n)
	case json.Number:
		i, _ := n.Int64()
		if i < 0 {
			return 0
		}
		return uint32(i)
	case int:
		if n < 0 {
			return 0
		}
		return uint32(n)
	case int64:
		if n < 0 {
			return 0
		}
		return uint32(n)
	default:
		return 0
	}
}

func headerFirst(headers map[string][]string, names ...string) string {
	if headers == nil {
		return ""
	}
	for _, name := range names {
		for k, vals := range headers {
			if strings.EqualFold(k, name) && len(vals) > 0 && strings.TrimSpace(vals[0]) != "" {
				return strings.TrimSpace(vals[0])
			}
		}
	}
	return ""
}

var (
	reBearer    = regexp.MustCompile(`(?i)(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[A-Za-z0-9._\-+=/]+`)
	reAPIKeyHdr = regexp.MustCompile(`(?i)((?:x-api-key|api[_-]?key|anthropic-api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+=/]+`)
	reSkToken   = regexp.MustCompile(`\b(sk-[A-Za-z0-9]{10,})\b`)
	reRivetKey  = regexp.MustCompile(`\b(rivet_[a-f0-9]{20,})\b`)
	reOpenAIKey = regexp.MustCompile(`\b(sk-proj-[A-Za-z0-9\-_]{10,})\b`)
	reJWT       = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
)

func redactSecrets(s string) string {
	s = reBearer.ReplaceAllString(s, `${1}[REDACTED]`)
	s = reAPIKeyHdr.ReplaceAllString(s, `${1}[REDACTED]`)
	s = reOpenAIKey.ReplaceAllString(s, `[REDACTED]`)
	s = reSkToken.ReplaceAllString(s, `[REDACTED]`)
	s = reRivetKey.ReplaceAllString(s, `[REDACTED]`)
	s = reJWT.ReplaceAllString(s, `[REDACTED]`)
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
