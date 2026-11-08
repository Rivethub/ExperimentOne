// Package rivetsink forwards captured proxy traffic to Rivet's local ingest API.
// Credentials are never sent — only request/response bodies and metadata.
package rivetsink

import (
	"bytes"
	"encoding/json"
	"net/http"
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

// Wrapper dual-writes to an inner RequestLogger and posts events to Rivet.
type Wrapper struct {
	inner     logging.RequestLogger
	ingestURL string
	client    *http.Client
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
		inner:     inner,
		ingestURL: strings.TrimRight(url, "/"),
		client:    &http.Client{Timeout: 2 * time.Second},
	}
}

func (w *Wrapper) IsEnabled() bool { return w.inner.IsEnabled() }

func (w *Wrapper) SetEnabled(enabled bool) {
	if setter, ok := w.inner.(interface{ SetEnabled(bool) }); ok {
		setter.SetEnabled(enabled)
	}
}

func (w *Wrapper) LogRequest(url, method string, requestHeaders map[string][]string, body []byte, statusCode int, responseHeaders map[string][]string, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline []byte, apiResponseErrors []*interfaces.ErrorMessage, requestID string, requestTimestamp, apiResponseTimestamp time.Time) error {
	err := w.inner.LogRequest(url, method, requestHeaders, body, statusCode, responseHeaders, response, websocketTimeline, apiRequest, apiResponse, apiWebsocketTimeline, apiResponseErrors, requestID, requestTimestamp, apiResponseTimestamp)
	w.forward(url, requestHeaders, body, response, statusCode, requestID, requestTimestamp, apiResponseTimestamp)
	return err
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

	mu         sync.Mutex
	chunks     []byte
	apiResp    []byte
	status     int
	closed     bool
	finished   time.Time
}

func appendCapped(dst *[]byte, chunk []byte, capBytes int) {
	if len(*dst) >= capBytes {
		return
	}
	remain := capBytes - len(*dst)
	if len(chunk) > remain {
		*dst = append(*dst, chunk[:remain]...)
	} else {
		*dst = append(*dst, chunk...)
	}
}

func (s *streamWrapper) WriteChunkAsync(chunk []byte) {
	s.inner.WriteChunkAsync(chunk)
	s.mu.Lock()
	defer s.mu.Unlock()
	appendCapped(&s.chunks, chunk, 96*1024)
}

func (s *streamWrapper) WriteStatus(status int, headers map[string][]string) error {
	s.mu.Lock()
	s.status = status
	s.mu.Unlock()
	return s.inner.WriteStatus(status, headers)
}

func (s *streamWrapper) WriteAPIRequest(apiRequest []byte) error {
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
	resp := append([]byte(nil), s.chunks...)
	if len(s.apiResp) > 0 {
		// Prefer upstream API response when present (richer usage JSON).
		resp = append(resp, '\n')
		resp = append(resp, s.apiResp...)
	}
	status := s.status
	started := s.started
	finished := s.finished
	s.mu.Unlock()

	s.parent.forward(s.url, s.headers, s.reqBody, resp, status, s.requestID, started, finished)
	return err
}

func (w *Wrapper) forward(url string, headers map[string][]string, reqBody, respBody []byte, statusCode int, requestID string, started, finished time.Time) {
	provider := inferProvider(url, reqBody)
	meta := parseMeta(provider, headers, reqBody, respBody)

	content := truncate(string(reqBody), 64*1024)
	if len(respBody) > 0 {
		resp := truncate(string(respBody), 64*1024)
		joined := content + "\n---\n" + resp
		content = truncate(joined, 96*1024)
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
	var model, sessionID, projectID *string
	if meta.Model != "" {
		model = &meta.Model
	}
	if meta.SessionID != "" {
		sessionID = &meta.SessionID
	}
	if meta.ProjectID != "" {
		projectID = &meta.ProjectID
	}
	role := meta.Role
	if role == "" {
		role = "unknown"
	}

	evt := trafficEvent{
		ID:         uuid.NewString(),
		Ts:         time.Now().UTC().Format(time.RFC3339Nano),
		Provider:   provider,
		Model:      model,
		SessionID:  sessionID,
		ProjectID:  projectID,
		RequestID:  rid,
		Role:       role,
		Content:    &content,
		TokensIn:   meta.TokensIn,
		TokensOut:  meta.TokensOut,
		LatencyMs:  latency,
		StatusCode: status,
	}
	payload, err := json.Marshal(evt)
	if err != nil {
		return
	}
	endpoint := w.ingestURL + "/v1/ingest"
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	go func() {
		resp, err := w.client.Do(req)
		if err != nil {
			log.Debugf("rivet sink: %v", err)
			return
		}
		_ = resp.Body.Close()
	}()
}

func inferProvider(url string, reqBody []byte) string {
	u := strings.ToLower(url)
	switch {
	case strings.Contains(u, "anthropic") || strings.Contains(u, "/v1/messages"):
		return "claude"
	case strings.Contains(u, "openai") || strings.Contains(u, "/v1/responses") || strings.Contains(u, "/v1/chat/completions"):
		return "codex"
	case strings.Contains(u, "antigravity") || strings.Contains(u, "cloudcode"):
		return "antigravity"
	case strings.Contains(u, "kimi.ai") || strings.Contains(u, "kimi-ai"):
		return "kimi-ai"
	case strings.Contains(u, "kimi") || strings.Contains(u, "moonshot"):
		return "kimi"
	case strings.Contains(u, "x.ai") || strings.Contains(u, "/xai") || strings.Contains(u, "grok"):
		return "xai"
	case strings.Contains(u, "meta.com") || strings.Contains(u, "llama"):
		return "meta"
	case strings.Contains(u, "devin"):
		return "devin"
	case strings.Contains(u, "vertex") || strings.Contains(u, "aiplatform.googleapis"):
		return "vertex"
	case strings.Contains(u, "gemini") || strings.Contains(u, "generativelanguage.googleapis"):
		return "gemini"
	}
	// Fall back to body shape / model id.
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

func applyUsage(meta *parsedMeta, provider string, obj map[string]any) {
	usage, _ := obj["usage"].(map[string]any)
	if usage == nil {
		return
	}
	switch provider {
	case "claude":
		meta.TokensIn = uintFrom(usage, "input_tokens")
		meta.TokensOut = uintFrom(usage, "output_tokens")
		// Cache tokens still count as input for rollups.
		meta.TokensIn += uintFrom(usage, "cache_creation_input_tokens")
		meta.TokensIn += uintFrom(usage, "cache_read_input_tokens")
	default:
		// OpenAI / Codex / Responses API
		if v := uintFrom(usage, "prompt_tokens"); v > 0 {
			meta.TokensIn = v
		} else {
			meta.TokensIn = uintFrom(usage, "input_tokens")
		}
		if v := uintFrom(usage, "completion_tokens"); v > 0 {
			meta.TokensOut = v
		} else {
			meta.TokensOut = uintFrom(usage, "output_tokens")
		}
		if meta.TokensIn == 0 && meta.TokensOut == 0 {
			if total := uintFrom(usage, "total_tokens"); total > 0 {
				meta.TokensIn = total
			}
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
		applyUsage(meta, provider, obj)
		// Anthropic message_delta / message_start usage nesting
		if msg, ok := obj["message"].(map[string]any); ok {
			applyUsage(meta, provider, msg)
			if meta.Model == "" {
				if m, ok := msg["model"].(string); ok {
					meta.Model = m
				}
			}
		}
		if usage, ok := obj["usage"].(map[string]any); ok {
			tmp := map[string]any{"usage": usage}
			applyUsage(meta, provider, tmp)
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
	reBearer     = regexp.MustCompile(`(?i)(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[A-Za-z0-9._\-+=/]+`)
	reAPIKeyHdr  = regexp.MustCompile(`(?i)((?:x-api-key|api[_-]?key|anthropic-api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+=/]+`)
	reSkToken    = regexp.MustCompile(`\b(sk-[A-Za-z0-9]{10,})\b`)
	reRivetKey   = regexp.MustCompile(`\b(rivet_[a-f0-9]{20,})\b`)
	reOpenAIKey  = regexp.MustCompile(`\b(sk-proj-[A-Za-z0-9\-_]{10,})\b`)
	reJWT        = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
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
