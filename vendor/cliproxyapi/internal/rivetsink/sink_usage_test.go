package rivetsink

import "testing"

func TestClaudeUsageHighWaterNotAdditive(t *testing.T) {
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
			"input_tokens":                float64(100),
			"cache_read_input_tokens":     float64(50),
			"output_tokens":               float64(20),
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
	meta := parsedMeta{}
	raw := "data: {\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"output_tokens\":1},\"response\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"output_tokens\":1}}}\n"
	parseStreamMeta(&meta, "claude", raw)
	if meta.TokensIn != 15 {
		t.Fatalf("TokensIn=%d want 15 (no triple-count)", meta.TokensIn)
	}
}

func TestGeminiUsageMetadata(t *testing.T) {
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
	body := []byte(`{"model":"claude-sonnet-4-5"}`)
	if got := inferProvider("https://aiplatform.googleapis.com/v1/projects/x", body); got != "vertex" {
		t.Fatalf("vertex+claude model → %q want vertex", got)
	}
	if got := inferProvider("http://127.0.0.1:8317/antigravity.v1/messages", body); got != "antigravity" {
		t.Fatalf("antigravity+claude → %q want antigravity", got)
	}
}

func TestInferProviderFromCaptureUsesAuthPool(t *testing.T) {
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
	req := []byte(`{"model":"claude-sonnet-4-5"}`)
	retry := []byte("=== API REQUEST 1 ===\nUpstream URL: https://api.anthropic.com/v1/messages\nAuth: provider=claude, auth_id=c1\n\nBody:\n{}\n\n=== API REQUEST 2 ===\nUpstream URL: https://aiplatform.googleapis.com/v1/x\nAuth: provider=vertex, auth_id=v1\n\nBody:\n{}\n\n")
	if got := inferProviderFromCapture("/v1/messages", req, retry); got != "vertex" {
		t.Fatalf("failover → %q want vertex", got)
	}
}

func TestKimiAIPoolFromAuthContext(t *testing.T) {
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
