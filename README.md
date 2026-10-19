# netstatus

Prosty monitor hostów z podglądem w przeglądarce. Dla każdego hosta pokazuje:

- **PING** – `UP` / `DOWN`
- **PORT** – `OPEN` / `CLOSED` (test połączenia TCP na porcie z konfiguracji)

Wyniki odświeżają się na żywo, bez przeładowania strony.

## Wymagania

- Node.js 18+
- systemowe polecenie `ping`

Brak zależności – `npm install` nie jest potrzebny.

## Uruchomienie

```sh
npm start
```

Strona: http://localhost:3000

Port można też podać jednorazowo: `PORT=8080 npm start`.

## hosts.json

Jeden host na linię – adres IP albo nazwa. Puste linie i komentarze `#` są pomijane.

```
192.168.1.1
8.8.8.8
google.com   # komentarz
```

Działa też zwykła tablica JSON: `["192.168.1.1", "google.com"]`.

## config.json

```json
{
  "port": 443,
  "listenPort": 3000,
  "listenHost": "0.0.0.0",
  "interval": 5000,
  "pingTimeout": 1000,
  "tcpTimeout": 1000,
  "concurrency": 64
}
```

| Pole          | Opis                                                         |
|---------------|--------------------------------------------------------------|
| `port`        | port TCP testowany na każdym hoście                          |
| `listenPort`  | port, na którym działa strona www                            |
| `listenHost`  | adres nasłuchu (`0.0.0.0` – cała sieć, `127.0.0.1` – lokalnie) |
| `interval`    | co ile ms powtarzać sprawdzanie                              |
| `pingTimeout` | limit czasu pinga (ms)                                       |
| `tcpTimeout`  | limit czasu połączenia TCP (ms)                              |
| `concurrency` | ile hostów sprawdzać równolegle                              |

Zmiany w `hosts.json` i w polach `port`, `interval`, `pingTimeout`, `tcpTimeout`, `concurrency`
są wczytywane w kolejnym cyklu, bez restartu. Zmiana `listenPort` / `listenHost` wymaga restartu.

## API

- `GET /api/status` – aktualny stan wszystkich hostów (JSON)
- `GET /api/events` – strumień zmian (Server-Sent Events), z którego korzysta strona
