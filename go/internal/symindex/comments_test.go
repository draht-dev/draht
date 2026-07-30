package symindex

import (
	"reflect"
	"strings"
	"testing"
)

func TestExtractComments_UnknownLanguageReturnsNil(t *testing.T) {
	got := ExtractComments([]byte("// NOTE: x\n"), "json")
	if got != nil {
		t.Fatalf("want nil for unrecognised language, got %+v", got)
	}
}

func TestExtractComments_LineCommentTypeScript(t *testing.T) {
	content := []byte("const x = 1; // NOTE: hello\n")
	got := ExtractComments(content, "typescript")
	want := []Comment{{Line: 1, Text: " NOTE: hello"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestExtractComments_LineCommentURLGuard(t *testing.T) {
	// "http://example.com" must not be misread as a "//" comment start.
	content := []byte(`const u = "http://example.com"; // WHY: real comment` + "\n")
	got := ExtractComments(content, "typescript")
	if len(got) != 1 {
		t.Fatalf("want exactly 1 comment, got %d: %+v", len(got), got)
	}
	if !strings.Contains(got[0].Text, "WHY: real comment") {
		t.Errorf("want the real trailing comment, got %q", got[0].Text)
	}
}

func TestExtractComments_SingleLineBlockComment(t *testing.T) {
	content := []byte("doThing(); /* HACK: patch until upstream fixes it */\n")
	got := ExtractComments(content, "typescript")
	if len(got) != 1 {
		t.Fatalf("want exactly 1 comment, got %d: %+v", len(got), got)
	}
	if got[0].Text != " HACK: patch until upstream fixes it " {
		t.Errorf("got text %q", got[0].Text)
	}
}

func TestExtractComments_MultiLineBlockComment(t *testing.T) {
	content := []byte("/* FIXME: line one\ncontinuation\nend */\ncode()\n")
	got := ExtractComments(content, "typescript")
	want := []Comment{
		{Line: 1, Text: " FIXME: line one"},
		{Line: 2, Text: "continuation"},
		{Line: 3, Text: "end "},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestExtractComments_PythonHash(t *testing.T) {
	content := []byte("x = 1  # TODO: refactor\n")
	got := ExtractComments(content, "python")
	if len(got) != 1 || !strings.Contains(got[0].Text, "TODO: refactor") {
		t.Fatalf("got %+v", got)
	}
}

func TestExtractComments_HTMLBlockOnly(t *testing.T) {
	content := []byte("<div><!-- WHY: keep for legacy browsers --></div>\n")
	got := ExtractComments(content, "html")
	if len(got) != 1 {
		t.Fatalf("want 1 comment, got %+v", got)
	}
	if !strings.Contains(got[0].Text, "WHY: keep for legacy browsers") {
		t.Errorf("got text %q", got[0].Text)
	}
}

func TestExtractComments_SQLLineAndBlock(t *testing.T) {
	content := []byte("-- NOTE: index this column\nSELECT 1; /* PERF: add cache */\n")
	got := ExtractComments(content, "sql")
	if len(got) != 2 {
		t.Fatalf("want 2 comments, got %+v", got)
	}
	if !strings.Contains(got[0].Text, "NOTE: index this column") {
		t.Errorf("comment 0: got %q", got[0].Text)
	}
	if !strings.Contains(got[1].Text, "PERF: add cache") {
		t.Errorf("comment 1: got %q", got[1].Text)
	}
}

func TestExtractComments_ScanCap(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 500; i++ {
		b.WriteString("x(); // filler\n")
	}
	got := ExtractComments([]byte(b.String()), "typescript")
	if len(got) != CommentScanCap {
		t.Fatalf("want exactly %d comments (one line comment per line, no multi-push lines), got %d", CommentScanCap, len(got))
	}
}
