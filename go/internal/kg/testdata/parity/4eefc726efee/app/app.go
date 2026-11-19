package app

import (
	"fmt"

	"example.com/app/store"
)

type App struct {
	db *store.Store
}

func Run(w fmt.Stringer) {
	s := store.New(store.DefaultName)
	s.Save("k")
	a := &App{db: s}
	a.db.Close()
	w.String()
	fmt.Println(a)
}
