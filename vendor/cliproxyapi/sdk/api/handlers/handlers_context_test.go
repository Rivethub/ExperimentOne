package handlers

import "testing"

func TestNormalizeRivetAccountAuthID(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"  ", ""},
		{"codex-alice", "codex-alice.json"},
		{"codex-alice.json", "codex-alice.json"},
		{"Codex-Alice.JSON", "Codex-Alice.JSON"},
		{" nested/codex ", "nested/codex.json"},
	}
	for _, tc := range cases {
		if got := NormalizeRivetAccountAuthID(tc.in); got != tc.want {
			t.Fatalf("NormalizeRivetAccountAuthID(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}
