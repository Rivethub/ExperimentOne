package rivetsink

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// softSessionID builds a stable conversation key when the harness sent no session marker.
// Hash covers provider + account + model + a short fingerprint of the early prompt so
// follow-up turns in the same chat (same system + first user text) group together.
func softSessionID(provider, account, model string, reqBody []byte) string {
	fp := promptFingerprint(reqBody)
	if fp == "" && model == "" && account == "" {
		return ""
	}
	h := sha256.New()
	_, _ = fmt.Fprintf(h, "%s\n%s\n%s\n%s", provider, account, model, fp)
	sum := hex.EncodeToString(h.Sum(nil))
	if len(sum) > 32 {
		sum = sum[:32]
	}
	return "soft:" + sum
}

func promptFingerprint(reqBody []byte) string {
	if len(reqBody) == 0 {
		return ""
	}
	var req map[string]any
	if json.Unmarshal(reqBody, &req) != nil {
		// Non-JSON — hash a capped raw prefix.
		return truncate(string(reqBody), 512)
	}
	var parts []string
	if sys, ok := req["system"].(string); ok {
		parts = append(parts, "sys:"+truncate(strings.TrimSpace(sys), 240))
	}
	if msgs, ok := req["messages"].([]any); ok {
		parts = append(parts, messageFingerprint(msgs)...)
	}
	if input, ok := req["input"].([]any); ok {
		parts = append(parts, messageFingerprint(input)...)
	}
	if len(parts) == 0 {
		return truncate(string(reqBody), 512)
	}
	return strings.Join(parts, "\n")
}

func messageFingerprint(msgs []any) []string {
	var parts []string
	userSeen := 0
	for _, raw := range msgs {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		role = strings.ToLower(strings.TrimSpace(role))
		text := flattenContent(msg["content"])
		if text == "" {
			text = flattenContent(msg["text"])
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		switch role {
		case "system", "developer":
			parts = append(parts, role+":"+truncate(text, 240))
		case "user":
			if userSeen >= 1 {
				continue
			}
			userSeen++
			parts = append(parts, "user:"+truncate(text, 240))
		}
		if len(parts) >= 3 {
			break
		}
	}
	return parts
}

func flattenContent(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, item := range c {
			switch t := item.(type) {
			case string:
				b.WriteString(t)
			case map[string]any:
				if s, ok := t["text"].(string); ok {
					b.WriteString(s)
				}
			}
		}
		return b.String()
	default:
		return ""
	}
}
