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
	log "github.com/sirupsen/logrus"
)

type sinkError string

func (e sinkError) Error() string { return string(e) }

const errNoFileBodySource sinkError = "rivetsink: inner logger does not support file body sources"

// Wrapper dual-writes to an inner RequestLogger and posts events to Rivet.
// IsEnabled is always true while ingest is configured so middleware keeps
// capturing traffic even when on-disk request-log is disabled.
type Wrapper struct {
	inner    logging.RequestLogger
	sender   *queueSender
	blobsDir string
}

type trafficEvent struct {
	ID             string  `json:"id"`
	Ts             string  `json:"ts"`
	Provider       string  `json:"provider"`
	AccountLabel   *string `json:"account_label"`
	Model          *string `json:"model"`
	SessionID      *string `json:"session_id"`
	ProjectID      *string `json:"project_id"`
	Cwd            *string `json:"cwd,omitempty"`
	RequestID      *string `json:"request_id"`
	Role           string  `json:"role"`
	Content        *string `json:"content"`
	TokensIn       uint32  `json:"tokens_in"`
	TokensOut      uint32  `json:"tokens_out"`
	LatencyMs      *uint64 `json:"latency_ms"`
	StatusCode     *uint16 `json:"status_code"`
	BodyRef        *string `json:"body_ref"`
	CaptureQuality *string `json:"capture_quality,omitempty"`
}

type parsedMeta struct {
	Model     string
	SessionID string
	ProjectID string
	Cwd       string
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
		inner:    inner,
		sender:   newQueueSender(url, strings.TrimSpace(os.Getenv("RIVET_INGEST_KEY"))),
		blobsDir: strings.TrimSpace(os.Getenv("RIVET_BLOBS_DIR")),
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
	resp := mergeWebsocketIntoResponse(response, websocketTimeline, apiWebsocketTimeline)
	w.forward(url, requestHeaders, body, resp, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequest)
	return err
}

// LogRequestWithOptions preserves forced error-log writes on the inner logger.
func (w *Wrapper) LogRequestWithOptions(url, method string, requestHeaders map[string][]string, body []byte, statusCode int, responseHeaders map[string][]string, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline []byte, apiResponseErrors []*interfaces.ErrorMessage, force bool, requestID string, requestTimestamp, apiResponseTimestamp time.Time) error {
	err := w.logInnerWithForce(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline, apiResponseErrors, force, requestID, requestTimestamp, apiResponseTimestamp)
	resp := mergeWebsocketIntoResponse(response, websocketTimeline, apiWebsocketTimeline)
	w.forward(url, requestHeaders, body, resp, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequest)
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
	resp := mergeWebsocketIntoResponse(response, websocketTimeline, apiWebsocketTimeline)
	w.forward(url, requestHeaders, body, resp, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequest)
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
	resp := mergeWebsocketIntoResponse(response, websocketTimeline, apiWebsocketTimeline)
	w.forward(url, requestHeaders, body, resp, statusCode, requestID, requestTimestamp, apiResponseTimestamp, apiRequestForRivet)
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
	sw := &streamWrapper{
		inner:     writer,
		parent:    w,
		url:       url,
		headers:   headers,
		reqBody:   append([]byte(nil), body...),
		requestID: requestID,
		started:   time.Now(),
		provider:  inferProvider(url, body),
		eventID:   uuid.NewString(),
	}
	if file, rel, abs, spillErr := w.openSpill(sw.eventID); spillErr != nil {
		log.Warnf("rivet sink spill open: %v", spillErr)
	} else if file != nil {
		sw.spill = file
		sw.spillRel = rel
		sw.spillAbs = abs
		_, _ = file.WriteString("=== REQUEST ===\n")
		_, _ = file.Write(body)
		_, _ = file.WriteString("\n=== RESPONSE ===\n")
	}
	return sw, nil
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
	eventID   string

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

	spill      *os.File
	spillRel   string
	spillAbs   string
	wsTimeline []byte // upstream/downstream websocket event log
}

// appendHeadTail keeps the first and last previewRespBytes of a stream so
// long responses retain both the start (prompt context) and end (usage).
func appendHeadTail(head, tail *[]byte, chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	if len(*head) < previewRespBytes {
		need := previewRespBytes - len(*head)
		if len(chunk) <= need {
			*head = append(*head, chunk...)
			return
		}
		*head = append(*head, chunk[:need]...)
		chunk = chunk[need:]
	}
	*tail = append(*tail, chunk...)
	if len(*tail) > previewRespBytes {
		*tail = append([]byte(nil), (*tail)[len(*tail)-previewRespBytes:]...)
	}
}

func (s *streamWrapper) WriteChunkAsync(chunk []byte) {
	s.inner.WriteChunkAsync(chunk)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.spill != nil && len(chunk) > 0 {
		if _, err := s.spill.Write(chunk); err != nil {
			log.Warnf("rivet sink spill write: %v", err)
		}
	}
	appendHeadTail(&s.head, &s.tail, chunk)
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
	// Keep a short preview copy only; full upstream capture belongs in the spill file.
	s.apiResp = append([]byte(nil), apiResponse...)
	if len(s.apiResp) > previewRespBytes {
		s.apiResp = s.apiResp[:previewRespBytes]
	}
	if s.spill != nil && len(apiResponse) > 0 {
		_, _ = s.spill.WriteString("\n=== API RESPONSE ===\n")
		_, _ = s.spill.Write(apiResponse)
	}
	s.mu.Unlock()
	return s.inner.WriteAPIResponse(apiResponse)
}

func (s *streamWrapper) WriteAPIWebsocketTimeline(apiWebsocketTimeline []byte) error {
	err := s.inner.WriteAPIWebsocketTimeline(apiWebsocketTimeline)
	if len(apiWebsocketTimeline) == 0 {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wsTimeline = append([]byte(nil), apiWebsocketTimeline...)
	if s.spill != nil {
		_, _ = s.spill.WriteString("\n=== API WEBSOCKET TIMELINE ===\n")
		_, _ = s.spill.Write(apiWebsocketTimeline)
	}
	// Prefer WS frames for the Rivet preview when HTTP chunk body is empty
	// (Codex Responses WebSocket path).
	if len(s.head) == 0 && len(s.tail) == 0 {
		appendHeadTail(&s.head, &s.tail, apiWebsocketTimeline)
	} else {
		// Keep a truncated WS appendix in the preview so sessions aren't HTTP-only.
		marker := []byte("\n=== API WEBSOCKET TIMELINE ===\n")
		appendHeadTail(&s.head, &s.tail, marker)
		appendHeadTail(&s.head, &s.tail, apiWebsocketTimeline)
	}
	meta := parsedMeta{TokensIn: s.tokensIn, TokensOut: s.tokensOut, Model: s.model}
	parseStreamMeta(&meta, s.provider, string(apiWebsocketTimeline))
	s.tokensIn = meta.TokensIn
	s.tokensOut = meta.TokensOut
	if meta.Model != "" {
		s.model = meta.Model
	}
	return err
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
	respPreview := append([]byte(nil), s.head...)
	if len(s.tail) > 0 {
		if len(s.head) > 0 {
			respPreview = append(respPreview, []byte("\n…\n")...)
		}
		respPreview = append(respPreview, s.tail...)
	}
	if len(s.apiResp) > 0 {
		respPreview = append(respPreview, '\n')
		respPreview = append(respPreview, s.apiResp...)
	}
	// WS-only turns: head/tail may still be empty if WriteAPIWebsocketTimeline
	// never ran before Close (defensive — normally filled above).
	if len(respPreview) == 0 && len(s.wsTimeline) > 0 {
		respPreview = append([]byte(nil), s.wsTimeline...)
		if len(respPreview) > previewRespBytes*2 {
			half := previewRespBytes
			respPreview = append(append(respPreview[:half], []byte("\n…\n")...), respPreview[len(respPreview)-half:]...)
		}
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
	spill := s.spill
	spillRel := s.spillRel
	spillAbs := s.spillAbs
	eventID := s.eventID
	wsTimeline := append([]byte(nil), s.wsTimeline...)
	s.spill = nil
	s.mu.Unlock()

	var bodyRef string
	if spill != nil {
		_ = spill.Close()
		if _, finErr := finalizeSpill(spillAbs); finErr != nil {
			log.Warnf("rivet sink spill finalize: %v", finErr)
		} else {
			bodyRef = spillRel
		}
	} else if len(wsTimeline) > 0 && s.parent != nil && strings.TrimSpace(s.parent.blobsDir) != "" {
		// No open spill — still persist the WS timeline so Codex turns aren't lost.
		full := append([]byte(nil), reqBody...)
		if len(full) > 0 {
			full = append(full, []byte("\n---\n")...)
		}
		full = append(full, mergeWebsocketIntoResponse(nil, nil, wsTimeline)...)
		if rel, ok := s.parent.spillBody(eventID, redactSecrets(string(full))); ok {
			bodyRef = rel
		}
	}

	s.parent.forwardStream(url, headers, reqBody, respPreview, status, requestID, started, finished, provider, tokensIn, tokensOut, model, eventID, bodyRef, apiReq)
	// Inner streaming writer is often a no-op when request-log is off; force an error file.
	if s.parent.inner != nil && !s.parent.inner.IsEnabled() && (status >= 400 || len(apiErrs) > 0) {
		forceStatus := status
		if forceStatus < 400 {
			forceStatus = 500
		}
		_ = s.parent.logInnerWithForce(url, "POST", headers, reqBody, forceStatus, nil, respPreview, nil, apiReq, nil, nil, apiErrs, true, requestID, started, finished)
	}
	return err
}

func (w *Wrapper) forwardStream(url string, headers map[string][]string, reqBody, respPreview []byte, statusCode int, requestID string, started, finished time.Time, provider string, tokensIn, tokensOut uint32, modelHint, eventID, bodyRef string, apiRequest []byte) {
	if v := headerFirst(headers, "x-rivet-internal"); v != "" {
		return
	}
	meta := parseMeta(provider, headers, reqBody, respPreview)
	if tokensIn > 0 {
		meta.TokensIn = tokensIn
	}
	if tokensOut > 0 {
		meta.TokensOut = tokensOut
	}
	if modelHint != "" && meta.Model == "" {
		meta.Model = modelHint
	}
	w.emit(url, headers, reqBody, respPreview, statusCode, requestID, started, finished, provider, &meta, eventID, bodyRef, true, apiRequest)
}

func (w *Wrapper) forward(url string, headers map[string][]string, reqBody, respBody []byte, statusCode int, requestID string, started, finished time.Time, apiRequest []byte) {
	if v := headerFirst(headers, "x-rivet-internal"); v != "" {
		return
	}
	provider := inferProviderFromCapture(url, reqBody, apiRequest)
	meta := parseMeta(provider, headers, reqBody, respBody)
	w.emit(url, headers, reqBody, respBody, statusCode, requestID, started, finished, provider, &meta, "", "", false, apiRequest)
}

func (w *Wrapper) emit(url string, headers map[string][]string, reqBody, respBody []byte, statusCode int, requestID string, started, finished time.Time, provider string, meta *parsedMeta, eventID, existingBodyRef string, previewOnly bool, apiRequest []byte) {
	if meta == nil {
		meta = &parsedMeta{}
	}
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		eventID = uuid.NewString()
	}

	preview := redactSecrets(buildPreview(reqBody, respBody))
	content := preview
	var bodyRef *string
	if existingBodyRef != "" {
		bodyRef = &existingBodyRef
	} else if !previewOnly {
		full := string(reqBody)
		if len(respBody) > 0 {
			if full != "" {
				full += "\n---\n"
			}
			full += string(respBody)
		}
		full = redactSecrets(full)
		if rel, ok := w.spillBody(eventID, full); ok && len(full) > len(preview) {
			bodyRef = &rel
		} else {
			// Small enough (or no blobs dir) — keep the full payload in content.
			content = full
			if w.blobsDir == "" && len(full) > len(preview) {
				content = preview
			}
		}
	}

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
	var model, sessionID, projectID, cwd, accountLabel *string
	if meta.Model != "" {
		model = &meta.Model
	}
	if meta.ProjectID != "" {
		projectID = &meta.ProjectID
	}
	if meta.Cwd != "" {
		cwd = &meta.Cwd
	}
	if v := headerFirst(headers, "x-rivet-account", "x-account-label", "x-account-email", "x-goog-authenticated-user-email"); v != "" {
		accountLabel = &v
	} else if v := accountLabelFromAPIRequest(apiRequest); v != "" {
		accountLabel = &v
	}
	accountStr := ""
	if accountLabel != nil {
		accountStr = *accountLabel
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
	quality := "wire"
	if meta.SessionID != "" {
		sessionID = &meta.SessionID
	} else if soft := softSessionID(provider, accountStr, meta.Model, reqBody); soft != "" {
		sessionID = &soft
		quality = "soft"
	}

	evt := trafficEvent{
		ID:             eventID,
		Ts:             time.Now().UTC().Format(time.RFC3339Nano),
		Provider:       provider,
		AccountLabel:   accountLabel,
		Model:          model,
		SessionID:      sessionID,
		ProjectID:      projectID,
		Cwd:            cwd,
		RequestID:      rid,
		Role:           role,
		Content:        &content,
		TokensIn:       meta.TokensIn,
		TokensOut:      meta.TokensOut,
		LatencyMs:      latency,
		StatusCode:     status,
		BodyRef:        bodyRef,
		CaptureQuality: &quality,
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

// accountLabelFromAPIRequest maps the credential-pool auth_id (e.g. alice.json)
// into a stable account label when the client did not send one.
func accountLabelFromAPIRequest(apiRequest []byte) string {
	if len(apiRequest) == 0 {
		return ""
	}
	var lastAuthID string
	inHeaders := false
	for _, raw := range strings.Split(string(apiRequest), "\n") {
		line := strings.TrimSpace(raw)
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "=== api request") {
			inHeaders = true
			continue
		}
		if !inHeaders {
			continue
		}
		if lower == "body:" || strings.HasPrefix(lower, "body:") {
			inHeaders = false
			continue
		}
		if strings.HasPrefix(lower, "auth:") {
			if id := parseAuthField(line, "auth_id="); id != "" {
				lastAuthID = id
			}
		}
	}
	return humanizeAuthID(lastAuthID)
}

func humanizeAuthID(authID string) string {
	id := strings.TrimSpace(authID)
	if id == "" {
		return ""
	}
	id = strings.ReplaceAll(id, "\\", "/")
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	for _, ext := range []string{".json", ".jsonl", ".yaml", ".yml", ".toml"} {
		if strings.HasSuffix(strings.ToLower(id), ext) {
			id = id[:len(id)-len(ext)]
			break
		}
	}
	id = strings.TrimSpace(id)
	if id == "" || strings.EqualFold(id, "default") || strings.EqualFold(id, "auth") {
		return ""
	}
	return id
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
	// Hard evidence only: explicit project headers/fields. cwd is captured separately.
	if v := headerFirst(headers, "x-project-id", "x-rivet-project-id", "project-id", "openai-project", "x-openai-project"); v != "" {
		meta.ProjectID = v
	}

	var req map[string]any
	_ = json.Unmarshal(reqBody, &req)
	if req != nil {
		if m, ok := req["model"].(string); ok && m != "" {
			meta.Model = m
		}
		if meta.ProjectID == "" {
			if s, ok := req["project_id"].(string); ok {
				meta.ProjectID = strings.TrimSpace(s)
			} else if metaMap, ok := req["metadata"].(map[string]any); ok {
				if s, ok := metaMap["project_id"].(string); ok {
					meta.ProjectID = strings.TrimSpace(s)
				}
			}
		}
		meta.Cwd = extractCwd(req)
		meta.Role = inferRoleFromRequest(req)
	}
	meta.SessionID = extractSessionID(headers, req, reqBody)

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

// extractCwd pulls a working-directory signal when present. This is not a project
// classification — workers assign projects from cwd plus content/context later.
func extractCwd(req map[string]any) string {
	if req == nil {
		return ""
	}
	if s := strings.TrimSpace(asString(req["cwd"])); s != "" {
		return s
	}
	if gs, ok := req["git_state"].(map[string]any); ok {
		if s := strings.TrimSpace(asString(gs["cwd"])); s != "" {
			return s
		}
	}
	if metaMap, ok := req["metadata"].(map[string]any); ok {
		if s := strings.TrimSpace(asString(metaMap["cwd"])); s != "" {
			return s
		}
	}
	if safeguards, ok := req["safeguards"].([]any); ok {
		for _, item := range safeguards {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			ctx, ok := m["classifier_context"].(map[string]any)
			if !ok {
				continue
			}
			if s := strings.TrimSpace(asString(ctx["live_cwd"])); s != "" {
				return s
			}
		}
	}
	return ""
}

func asString(v any) string {
	s, _ := v.(string)
	return s
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

// extractSessionID resolves harness session markers from headers and request bodies.
// Claude Code: X-Claude-Code-Session-Id or metadata.user_id JSON / `_session_<uuid>` suffix.
// Codex / OpenAI-compat: session_id / Session-Id headers and body fields.
func extractSessionID(headers map[string][]string, req map[string]any, reqBody []byte) string {
	if v := headerFirst(headers,
		"x-claude-code-session-id",
		"x-session-id",
		"session-id",
		"session_id",
		"x-chat-id",
		"chat-id",
		"x-conversation-id",
		"conversation-id",
	); v != "" {
		return v
	}

	if req == nil && len(reqBody) > 0 {
		_ = json.Unmarshal(reqBody, &req)
	}
	if req == nil {
		return ""
	}

	for _, key := range []string{"session_id", "conversation_id", "chat_id"} {
		if s, ok := req[key].(string); ok {
			if s = strings.TrimSpace(s); s != "" {
				return s
			}
		}
	}

	metaMap, _ := req["metadata"].(map[string]any)
	if metaMap != nil {
		for _, key := range []string{"session_id", "conversation_id"} {
			if s, ok := metaMap[key].(string); ok {
				if s = strings.TrimSpace(s); s != "" {
					return s
				}
			}
		}
		if s, ok := metaMap["user_id"].(string); ok {
			if sid := sessionIDFromClaudeUserID(s); sid != "" {
				return sid
			}
		}
	}
	return ""
}

var claudeCodeSessionSuffixPattern = regexp.MustCompile(`_session_([a-f0-9-]+)$`)

func sessionIDFromClaudeUserID(userID string) string {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ""
	}
	if matches := claudeCodeSessionSuffixPattern.FindStringSubmatch(userID); len(matches) >= 2 {
		return matches[1]
	}
	if strings.HasPrefix(userID, "{") {
		var nested map[string]any
		if json.Unmarshal([]byte(userID), &nested) == nil {
			if s, ok := nested["session_id"].(string); ok {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
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
