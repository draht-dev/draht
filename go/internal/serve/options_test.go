package serve

import "testing"

func TestParseOptions_Defaults(t *testing.T) {
	o := ParseOptions(nil)
	if o.Port != 4878 {
		t.Errorf("Port = %d, want 4878", o.Port)
	}
	if o.OpenBrowser {
		t.Errorf("OpenBrowser = true, want false (default)")
	}
	if o.MaxRetries != 10 {
		t.Errorf("MaxRetries = %d, want 10", o.MaxRetries)
	}
	if o.MaxClients != 64 {
		t.Errorf("MaxClients = %d, want 64", o.MaxClients)
	}
}

func TestParseOptions_BarePortDigits(t *testing.T) {
	o := ParseOptions([]string{"9000"})
	if o.Port != 9000 {
		t.Errorf("Port = %d, want 9000", o.Port)
	}
}

func TestParseOptions_PortFlagLongAndShort(t *testing.T) {
	for _, argv := range [][]string{{"--port", "5000"}, {"-p", "5000"}} {
		o := ParseOptions(argv)
		if o.Port != 5000 {
			t.Errorf("argv=%v Port = %d, want 5000", argv, o.Port)
		}
	}
}

func TestParseOptions_PortFlagConsumesNextTokenUnconditionally_NonNumericKeepsDefault(t *testing.T) {
	o := ParseOptions([]string{"--port", "not-a-number"})
	if o.Port != 4878 {
		t.Errorf("Port = %d, want 4878 (parseInt failure keeps prior value)", o.Port)
	}
}

func TestParseOptions_PortFlagAtEndOfArgv(t *testing.T) {
	o := ParseOptions([]string{"--port"})
	if o.Port != 4878 {
		t.Errorf("Port = %d, want 4878 (nothing to consume)", o.Port)
	}
}

func TestParseOptions_OpenAndNoOpen(t *testing.T) {
	o := ParseOptions([]string{"--open"})
	if !o.OpenBrowser {
		t.Errorf("OpenBrowser = false, want true")
	}
	o = ParseOptions([]string{"--open", "--no-open"})
	if o.OpenBrowser {
		t.Errorf("OpenBrowser = true, want false (--no-open wins, later flags win)")
	}
}

func TestParseOptions_LaterFlagsWin(t *testing.T) {
	o := ParseOptions([]string{"--port", "1111", "2222"})
	if o.Port != 2222 {
		t.Errorf("Port = %d, want 2222 (bare digits after --port wins)", o.Port)
	}
}
