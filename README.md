# netstatus

<img width="1406" height="145" alt="image" src="https://github.com/user-attachments/assets/f6bfd460-7810-4d30-9e4e-a843942f6c56" />


Prosty monitor hostów z podglądem w przeglądarce. Dla każdego hosta pokazuje:

- **PING** – `UP` / `DOWN`
- **PORT** – `OPEN` / `CLOSED` (test połączenia TCP na porcie z konfiguracji)

Wyniki odświeżają się na żywo, bez przeładowania strony. Nazwy hostów są tłumaczone na IP
tylko raz i zapamiętywane, więc wolny DNS nie spowalnia sprawdzania.

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

## Strona www

- hosty w dwóch kolumnach (na wąskim ekranie w jednej); gdy lista zawiera wyłącznie adresy IP
  (np. same podsieci), strona zajmuje całą szerokość okna i mieści tyle kolumn, ile się zmieści
- przy nazwie hosta – rozwiązany adres IP
- status PING i PORT z czasem odpowiedzi w ms
- kolumna „Zmiana” – ile czasu minęło od ostatniej zmiany statusu (pełna data po najechaniu myszą)
- liczniki UP / DOWN / OPEN / CLOSED w nagłówku, liczba hostów DOWN w tytule karty
- filtr po nazwie lub IP, sortowanie po kliknięciu w nagłówek kolumny
- jasny i ciemny motyw (wg ustawień systemu)

## hosts.json

Jeden wpis na linię – adres IP, nazwa albo podsieć (CIDR). Puste linie i komentarze `#` są pomijane.

```
192.168.1.1
8.8.8.8
google.com     # komentarz
10.0.0.0/24    # cała podsieć: 10.0.0.1 – 10.0.0.254
```

Podsieć jest rozwijana na pojedyncze adresy; adres sieci i broadcast są pomijane (poza /31 i /32).
Największa obsługiwana podsieć to /16. Powtórzone adresy są pokazywane tylko raz.

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
  "concurrency": 64,
  "dnsTtl": 3600,
  "dnsTimeout": 3000
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
| `dnsTtl`      | po ilu sekundach odświeżać IP nazwy (w tle)                  |
| `dnsTimeout`  | limit czasu pierwszego rozwiązania nazwy (ms)                |

Zmiany w `hosts.json` i w `config.json` są wczytywane w kolejnym cyklu, bez restartu –
wyjątkiem jest `listenPort` / `listenHost`, których zmiana wymaga restartu.
Starsza nazwa pola `httpPort` nadal działa jako `listenPort`.

## Cache DNS

Nazwy hostów są zamieniane na IP tylko raz, a ping i test portu idą już bezpośrednio na adres IP.
Rozwiązany adres jest wyświetlany obok nazwy i zapisywany w `dns-cache.json`, więc po restarcie
nie trzeba czekać na DNS. Co `dnsTtl` sekund adres jest odświeżany w tle; do tego czasu
używany jest zapamiętany IP. Żeby wymusić ponowne rozwiązanie wszystkich nazw, usuń `dns-cache.json`
i zrestartuj program.

## API

- `GET /api/status` – aktualny stan wszystkich hostów (JSON)
- `GET /api/events` – strumień zmian (Server-Sent Events), z którego korzysta strona

## Pliki

| Plik                | Opis                                               |
|---------------------|----------------------------------------------------|
| `server.js`         | serwer: sprawdzanie hostów, cache DNS, serwer www   |
| `public/index.html` | strona z tabelą                                    |
| `hosts.json`        | lista hostów                                       |
| `config.json`       | konfiguracja                                       |
| `dns-cache.json`    | zapamiętane adresy IP (tworzony automatycznie, w `.gitignore`) |
