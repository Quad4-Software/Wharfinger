package collect

import "testing"

func TestCountUpdateLines(t *testing.T) {
	cases := []struct {
		out  string
		want int
	}{
		{"", 0},
		{"\n\n", 0},
		{"Listing...", 0},
		{"pkg.x86_64 1.2-3 updates", 1},
		{"Last metadata expiration check: 0:01:00 ago\npkg 1.2 repo\nother 2.0 repo\n", 2},
	}
	for _, c := range cases {
		if got := countUpdateLines(c.out); got != c.want {
			t.Fatalf("countUpdateLines(%q) = %d want %d", c.out, got, c.want)
		}
	}
}
