package store

type Store struct {
	name string
}

type (
	Key  string
	kind int
)

const (
	DefaultName = "main"
	limit       = 10
)

func New(name string) *Store {
	return &Store{name: name}
}
