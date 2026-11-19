package store

type Writer interface {
	Write(p []byte) (int, error)
}

type writer struct{ Writer }
