package logging

import (
	"strings"
	"testing"

	log "github.com/sirupsen/logrus"
)

func TestRedactHookMasksBearerAndStructuredSecrets(t *testing.T) {
	hook := &RedactHook{}
	entry := log.WithFields(log.Fields{
		"Authorization": "Bearer super-secret-token-value",
		"refresh_token": "refresh-secret-value",
		"note":          "ok",
	})
	entry.Message = `Use API key sk-abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnop`
	entry.Level = log.InfoLevel

	if err := hook.Fire(entry); err != nil {
		t.Fatalf("Fire: %v", err)
	}
	if strings.Contains(entry.Message, "sk-abcdefghijklmnopqrstuvwxyz") {
		t.Fatalf("sk key still present: %q", entry.Message)
	}
	if strings.Contains(entry.Message, "abcdefghijklmnop") {
		t.Fatalf("bearer token still present: %q", entry.Message)
	}
	auth, _ := entry.Data["Authorization"].(string)
	if strings.Contains(auth, "super-secret-token-value") {
		t.Fatalf("authorization field not masked: %q", auth)
	}
	refresh, _ := entry.Data["refresh_token"].(string)
	if strings.Contains(refresh, "refresh-secret-value") {
		t.Fatalf("refresh_token not masked: %q", refresh)
	}
	if entry.Data["note"] != "ok" {
		t.Fatalf("non-sensitive field changed: %#v", entry.Data["note"])
	}
}
