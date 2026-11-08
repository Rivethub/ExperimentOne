package rivetsink

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeUsageHighWaterNotAdditive(t *testing.T) {
	t.Parallel()
	meta := parsedMeta{}
	frame1 := map[string]any{
		"usage": map[string]any{
			"input_tokens":                float64(100),
			"cache_read_input_tokens":     float64(50),
			"cache_creation_input_tokens": float64(0),
			"output_tokens":               float64(0),
		},
	}
	frame2 := map[string]any{
		"usage": map[string]any{
			"input_tokens":            float64(100),
			"cache_read_input_tokens": float64(50),
			"output_tokens":           float64(20),
		},
	}
	applyUsage(&meta, "claude", frame1)
	applyUsage(&meta, "claude", frame2)
	applyUsage(&meta, "claude", frame2) // duplicate envelope must not multiply
	if meta.TokensIn != 150 {
		t.Fatalf("TokensIn=%d want 150 (100+50 once)", meta.TokensIn)
	}
	if meta.TokensOut != 20 {
		t.Fatalf("TokensOut=%d want 20", meta.TokensOut)
	}
}

func TestParseStreamMetaDoesNotTripleUsage(t *testing.T) {
	t.Parallel()
	meta := parsedMeta{}
	raw := "data: {\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"output_tokens\":1},\"response\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"output_tokens\":1}}}\n"
	parseStreamMeta(&meta, "claude", raw)
	if meta.TokensIn != 15 {
		t.Fatalf("TokensIn=%d want 15 (no triple-count)", meta.TokensIn)
	}
}

func TestGeminiUsageMetadata(t *testing.T) {
	t.Parallel()
	meta := parsedMeta{}
	applyUsage(&meta, "gemini", map[string]any{
		"usageMetadata": map[string]any{
			"promptTokenCount":     float64(12),
			"candidatesTokenCount": float64(34),
			"totalTokenCount":      float64(46),
		},
	})
	if meta.TokensIn != 12 {
		t.Fatalf("TokensIn=%d want 12", meta.TokensIn)
	}
	if meta.TokensOut != 34 {
		t.Fatalf("TokensOut=%d want 34", meta.TokensOut)
	}
}

func TestGeminiThoughtsTokenCount(t *testing.T) {
	t.Parallel()
	meta := parsedMeta{}
	applyUsage(&meta, "gemini", map[string]any{
		"usageMetadata": map[string]any{
			"promptTokenCount":     float64(10),
			"candidatesTokenCount": float64(20),
			"thoughtsTokenCount":   float64(300),
			"totalTokenCount":      float64(330),
		},
	})
	if meta.TokensIn != 10 {
		t.Fatalf("TokensIn=%d want 10", meta.TokensIn)
	}
	if meta.TokensOut != 320 {
		t.Fatalf("TokensOut=%d want 320 (20+300 thoughts)", meta.TokensOut)
	}
}

func TestInferProviderAccountRouteBeatsModel(t *testing.T) {
	t.Parallel()
	body := []byte(`{"model":"claude-sonnet-4-5"}`)
	if got := inferProvider("https://aiplatform.googleapis.com/v1/projects/x", body); got != "vertex" {
		t.Fatalf("vertex+claude model → %q want vertex", got)
	}
	if got := inferProvider("http://127.0.0.1:8317/antigravity.v1/messages", body); got != "antigravity" {
		t.Fatalf("antigravity+claude → %q want antigravity", got)
	}
}

func TestInferProviderFromCaptureUsesAuthPool(t *testing.T) {
	t.Parallel()
	body := []byte(`{"model":"claude-sonnet-4-5"}`)
	api := []byte("=== API REQUEST 1 ===\nUpstream URL: https://aiplatform.googleapis.com/v1/projects/x\nAuth: provider=vertex, auth_id=sa.json, type=oauth\n")
	if got := inferProviderFromCapture("/v1/messages", body, api); got != "vertex" {
		t.Fatalf("client /v1/messages + vertex auth → %q want vertex", got)
	}
	apiAG := []byte("=== API REQUEST 1 ===\nUpstream URL: https://cloudcode-pa.googleapis.com/v1\nAuth: provider=antigravity, auth_id=ag.json\n")
	if got := inferProviderFromCapture("/v1/chat/completions", body, apiAG); got != "antigravity" {
		t.Fatalf("client openai path + antigravity auth → %q want antigravity", got)
	}
}

func TestInferProviderModelForOpenAICompat(t *testing.T) {
	t.Parallel()
	body := []byte(`{"model":"claude-3-5-sonnet"}`)
	if got := inferProvider("http://127.0.0.1:8317/v1/chat/completions", body); got != "claude" {
		t.Fatalf("openai-compat+claude → %q want claude", got)
	}
	o1 := []byte(`{"model":"o1-mini"}`)
	if got := inferProvider("http://127.0.0.1:8317/v1/responses", o1); got != "codex" {
		t.Fatalf("o1-mini → %q want codex", got)
	}
	// Loose substring "o1" must not match unrelated ids; unrecognized model ≠ codex.
	noise := []byte(`{"model":"photo1-preview"}`)
	if got := inferProvider("http://127.0.0.1:8317/v1/chat/completions", noise); got != "other" {
		t.Fatalf("photo1-preview → %q want other", got)
	}
}

func TestUsageShapeFollowsResponseNotPool(t *testing.T) {
	t.Parallel()
	req := []byte(`{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}`)
	claudeShaped := []byte(`{"type":"message","usage":{"input_tokens":10,"cache_read_input_tokens":100000,"cache_creation_input_tokens":0,"output_tokens":500}}`)
	for _, pool := range []string{"claude", "vertex", "antigravity"} {
		api := []byte("=== API REQUEST 1 ===\nUpstream URL: https://example\nAuth: provider=" + pool + ", auth_id=x\n\nBody:\n{}\n")
		p := inferProviderFromCapture("/v1/messages", req, api)
		m := parseMeta(p, nil, req, claudeShaped)
		if m.TokensIn != 100010 {
			t.Fatalf("pool %s TokensIn=%d want 100010 (cache counted)", pool, m.TokensIn)
		}
		if m.TokensOut != 500 {
			t.Fatalf("pool %s TokensOut=%d want 500", pool, m.TokensOut)
		}
	}

	openaiShaped := []byte(`{"id":"x","object":"chat.completion","usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}`)
	apiClaude := []byte("=== API REQUEST 1 ===\nUpstream URL: https://api.anthropic.com/v1/messages\nAuth: provider=claude, auth_id=c1\n\nBody:\n{}\n")
	p := inferProviderFromCapture("/v1/chat/completions", req, apiClaude)
	m := parseMeta(p, nil, req, openaiShaped)
	if p != "claude" {
		t.Fatalf("provider=%q want claude", p)
	}
	if m.TokensIn != 100 || m.TokensOut != 20 {
		t.Fatalf("openai-compat via claude pool tokens=%d/%d want 100/20", m.TokensIn, m.TokensOut)
	}
}

func TestFailoverUsesLastAuthPool(t *testing.T) {
	t.Parallel()
	req := []byte(`{"model":"claude-sonnet-4-5"}`)
	retry := []byte("=== API REQUEST 1 ===\nUpstream URL: https://api.anthropic.com/v1/messages\nAuth: provider=claude, auth_id=c1\n\nBody:\n{}\n\n=== API REQUEST 2 ===\nUpstream URL: https://aiplatform.googleapis.com/v1/x\nAuth: provider=vertex, auth_id=v1\n\nBody:\n{}\n\n")
	if got := inferProviderFromCapture("/v1/messages", req, retry); got != "vertex" {
		t.Fatalf("failover → %q want vertex", got)
	}
}

func TestMergeWebsocketIntoResponsePrefersAPITimeline(t *testing.T) {
	t.Parallel()
	got := mergeWebsocketIntoResponse([]byte(`{"ok":true}`), []byte("client-ws"), []byte("api-ws"))
	if !strings.Contains(string(got), `{"ok":true}`) {
		t.Fatalf("missing http body: %q", got)
	}
	if !strings.Contains(string(got), "api-ws") || !strings.Contains(string(got), "WEBSOCKET TIMELINE") {
		t.Fatalf("missing ws timeline: %q", got)
	}
	wsOnly := mergeWebsocketIntoResponse(nil, nil, []byte("Timestamp: t\nEvent: websocket.response\n{\"type\":\"response.completed\"}\n"))
	if !strings.Contains(string(wsOnly), "response.completed") {
		t.Fatalf("ws-only merge failed: %q", wsOnly)
	}
}

func TestParseStreamMetaFromWebsocketTimeline(t *testing.T) {
	t.Parallel()
	raw := "Timestamp: 2026-11-08T00:00:00Z\nEvent: websocket.response\n{\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4}}}\n"
	meta := parsedMeta{}
	parseStreamMeta(&meta, "codex", raw)
	if meta.Model != "gpt-5" {
		t.Fatalf("model=%q", meta.Model)
	}
	if meta.TokensIn != 10 || meta.TokensOut != 4 {
		t.Fatalf("tokens=%d/%d", meta.TokensIn, meta.TokensOut)
	}
}

func TestSoftSessionIDStableAcrossTurns(t *testing.T) {
	t.Parallel()
	req1 := []byte(`{"model":"gpt-5","messages":[{"role":"system","content":"You are helpful"},{"role":"user","content":"hello world"}]}`)
	req2 := []byte(`{"model":"gpt-5","messages":[{"role":"system","content":"You are helpful"},{"role":"user","content":"hello world"},{"role":"assistant","content":"hi"},{"role":"user","content":"next"}]}`)
	a := softSessionID("codex", "acct", "gpt-5", req1)
	b := softSessionID("codex", "acct", "gpt-5", req2)
	if a == "" || !strings.HasPrefix(a, "soft:") {
		t.Fatalf("soft id=%q", a)
	}
	if a != b {
		t.Fatalf("expected stable soft session, got %q vs %q", a, b)
	}
	other := softSessionID("codex", "acct", "gpt-5", []byte(`{"model":"gpt-5","messages":[{"role":"user","content":"different"}]}`))
	if other == a {
		t.Fatal("different prompts should not share soft session")
	}
}

func TestAccountLabelFromAPIRequest(t *testing.T) {
	t.Parallel()
	api := []byte("=== API REQUEST 1 ===\nUpstream URL: https://api.anthropic.com\nAuth: provider=claude, auth_id=alice.json, type=oauth\n\nBody:\n{}\n")
	if got := accountLabelFromAPIRequest(api); got != "alice" {
		t.Fatalf("label=%q want alice", got)
	}
}

func TestBuildPreviewTruncatesAndKeepsEnds(t *testing.T) {
	t.Parallel()
	req := []byte(strings.Repeat("r", previewReqBytes+100))
	resp := []byte("HEAD" + strings.Repeat("m", previewRespBytes) + "TAIL")
	prev := buildPreview(req, resp)
	if !strings.Contains(prev, "…[truncated]") {
		t.Fatalf("expected request truncation marker, got %q", prev[:64])
	}
	if !strings.Contains(prev, "HEAD") || !strings.Contains(prev, "TAIL") {
		t.Fatalf("preview should keep response head+tail: %q", prev[len(prev)-32:])
	}
	if !strings.Contains(prev, "\n---\n") {
		t.Fatalf("preview missing separator")
	}
}

func TestSpillBodyWritesRelativeRef(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	w := &Wrapper{blobsDir: dir}
	rel, ok := w.spillBody("11111111-1111-1111-1111-111111111111", "full body payload")
	if !ok {
		t.Fatal("expected spill")
	}
	if !strings.HasPrefix(rel, "traffic/") || !strings.HasSuffix(rel, ".txt") {
		t.Fatalf("unexpected rel %q", rel)
	}
	raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "full body payload" {
		t.Fatalf("blob=%q", raw)
	}
}

func TestExtractSessionIDClaudeCodeMetadata(t *testing.T) {
	t.Parallel()
	req := []byte(`{"model":"claude-sonnet-4-5","metadata":{"user_id":"{\"device_id\":\"d\",\"account_uuid\":\"\",\"session_id\":\"sess-json-1\"}"},"messages":[{"role":"user","content":"hi"}]}`)
	m := parseMeta("claude", nil, req, nil)
	if m.SessionID != "sess-json-1" {
		t.Fatalf("SessionID=%q want sess-json-1", m.SessionID)
	}

	suffix := []byte(`{"metadata":{"user_id":"user_device_session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}}`)
	m = parseMeta("claude", nil, suffix, nil)
	if m.SessionID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatalf("SessionID=%q want suffix uuid", m.SessionID)
	}

	hdr := map[string][]string{"X-Claude-Code-Session-Id": {"hdr-sess"}}
	m = parseMeta("claude", hdr, req, nil)
	if m.SessionID != "hdr-sess" {
		t.Fatalf("header must win: SessionID=%q", m.SessionID)
	}
}

func TestExtractSessionIDCodexHeaders(t *testing.T) {
	t.Parallel()
	hdr := map[string][]string{"session_id": {"codex-sess"}}
	m := parseMeta("codex", hdr, []byte(`{"model":"gpt-5"}`), nil)
	if m.SessionID != "codex-sess" {
		t.Fatalf("SessionID=%q want codex-sess", m.SessionID)
	}
	body := []byte(`{"session_id":"body-sess","model":"gpt-5"}`)
	m = parseMeta("codex", nil, body, nil)
	if m.SessionID != "body-sess" {
		t.Fatalf("SessionID=%q want body-sess", m.SessionID)
	}
}

func TestKimiAIPoolFromAuthContext(t *testing.T) {
	t.Parallel()
	req := []byte(`{"model":"kimi-k2"}`)
	// Ordinary kimi.com stays on the kimi pool even if the filename looks like kimi-ai.
	com := []byte("=== API REQUEST 1 ===\nUpstream URL: https://api.kimi.com/coding/v1/chat\nAuth: provider=kimi, auth_id=kimi-ai-foo.json\n\nBody:\n{}\n")
	if got := inferProviderFromCapture("/v1/chat/completions", req, com); got != "kimi" {
		t.Fatalf("kimi.com → %q want kimi", got)
	}
	ai := []byte("=== API REQUEST 1 ===\nUpstream URL: https://api.kimi.ai/v1/chat\nAuth: provider=kimi, auth_id=acct.json\n\nBody:\n{}\n")
	if got := inferProviderFromCapture("/v1/chat/completions", req, ai); got != "kimi-ai" {
		t.Fatalf("kimi.ai → %q want kimi-ai", got)
	}
	byID := []byte("=== API REQUEST 1 ===\nUpstream URL: https://relay.example/v1\nAuth: provider=kimi, auth_id=kimi-ai-user.json\n\nBody:\n{}\n")
	if got := inferProviderFromCapture("/v1/chat/completions", req, byID); got != "kimi-ai" {
		t.Fatalf("auth_id kimi-ai → %q want kimi-ai", got)
	}
}

func TestParseMetaCapturesCwdWithoutInferringProject(t *testing.T) {
	t.Parallel()
	body := []byte(`{
		"model":"claude-sonnet-4-5",
		"git_state":{"cwd":"/Users/me/work/rivet"},
		"safeguards":[{"type":"dangerous_tool_use","classifier_context":{"live_cwd":"/Users/me"}}]
	}`)
	m := parseMeta("claude", nil, body, nil)
	if m.Cwd != "/Users/me/work/rivet" {
		t.Fatalf("Cwd=%q want git_state.cwd", m.Cwd)
	}
	if m.ProjectID != "" {
		t.Fatalf("ProjectID=%q want empty (cwd is not a project)", m.ProjectID)
	}
	explicit := []byte(`{"model":"gpt-5","project_id":"acme","cwd":"/tmp/x"}`)
	m = parseMeta("codex", nil, explicit, nil)
	if m.ProjectID != "acme" {
		t.Fatalf("ProjectID=%q want acme", m.ProjectID)
	}
	if m.Cwd != "/tmp/x" {
		t.Fatalf("Cwd=%q want /tmp/x", m.Cwd)
	}
}
