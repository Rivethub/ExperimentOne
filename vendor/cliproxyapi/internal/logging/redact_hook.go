package logging

import (
	"regexp"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	log "github.com/sirupsen/logrus"
)

// sensitiveDataKeys are structured log field names that should never appear in cleartext.
var sensitiveDataKeys = map[string]struct{}{
	"authorization":  {},
	"access_token":   {},
	"refresh_token":  {},
	"id_token":       {},
	"api_key":        {},
	"apikey":         {},
	"proxy_access_key": {},
	"password":       {},
	"secret":         {},
	"token":          {},
	"client_secret":  {},
}

var (
	bearerRe = regexp.MustCompile(`(?i)\b(bearer|basic|api[_-]?key)\s+[A-Za-z0-9\-._~+/]+=*`)
	skRe     = regexp.MustCompile(`\bsk-[A-Za-z0-9]{8,}\b`)
	rivetRe  = regexp.MustCompile(`\brivet_[A-Za-z0-9]{8,}\b`)
	jwtRe    = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
)

// RedactHook scrubs secrets from logrus messages and structured fields before they
// reach stdout / rotating files / TUI / Home forwarders.
type RedactHook struct{}

// Levels implements logrus.Hook.
func (h *RedactHook) Levels() []log.Level {
	return log.AllLevels
}

// Fire implements logrus.Hook.
func (h *RedactHook) Fire(entry *log.Entry) error {
	if entry == nil {
		return nil
	}
	if entry.Message != "" {
		entry.Message = redactFreeText(entry.Message)
	}
	for key, value := range entry.Data {
		lower := strings.ToLower(strings.TrimSpace(key))
		if _, ok := sensitiveDataKeys[lower]; ok ||
			strings.Contains(lower, "token") ||
			strings.Contains(lower, "secret") ||
			strings.Contains(lower, "password") ||
			strings.Contains(lower, "api-key") ||
			strings.Contains(lower, "apikey") ||
			strings.Contains(lower, "authorization") {
			entry.Data[key] = maskField(key, value)
			continue
		}
		if s, ok := value.(string); ok && s != "" {
			entry.Data[key] = redactFreeText(s)
		}
	}
	return nil
}

func maskField(key string, value any) string {
	switch v := value.(type) {
	case string:
		return util.MaskSensitiveHeaderValue(key, v)
	case []byte:
		return util.MaskSensitiveHeaderValue(key, string(v))
	default:
		return "[REDACTED]"
	}
}

func redactFreeText(s string) string {
	out := bearerRe.ReplaceAllStringFunc(s, func(m string) string {
		parts := strings.SplitN(m, " ", 2)
		if len(parts) < 2 {
			return util.HideAPIKey(m)
		}
		return parts[0] + " " + util.HideAPIKey(parts[1])
	})
	out = skRe.ReplaceAllStringFunc(out, util.HideAPIKey)
	out = rivetRe.ReplaceAllStringFunc(out, util.HideAPIKey)
	out = jwtRe.ReplaceAllStringFunc(out, util.HideAPIKey)
	return out
}
