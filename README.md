# Hatz

Eine Ringjagd für genau drei im Browser, jeder am eigenen Rechner und ohne Anmeldung. Du jagst einen Mitspieler, der andere jagt dich.

Bisher gibt es einen Modus, die Ringjagd, mit Items und Einstellungen.

## So wird gespielt

1. Seite öffnen, Namen eingeben, **Raum erstellen**.
2. Den Einladungslink an die beiden anderen schicken.
3. Der Gastgeber startet die Runde. Freie Plätze übernehmen Bots, alleine ausprobieren geht also auch.

Bewegen mit WASD oder den Pfeiltasten, sprinten mit der Leertaste oder Shift, Item auslösen mit E.

Das Gerät des Gastgebers führt den Spielstand. Seine Seite muss offen bleiben, solange gespielt wird. Wer neu lädt oder kurz die Verbindung verliert, landet wieder auf seinem Platz, bis dahin vertritt ihn ein Bot.

## Regeln

- Drei Irrlichter in einem nächtlichen Irrgarten. Glut, Frost und Malve bilden einen Ring: Jeder jagt genau einen und wird vom anderen gejagt. Die Richtung des Rings wechselt von Runde zu Runde.
- Wer seine Beute berührt, bekommt einen Punkt, die Beute verliert einen. Sie setzt drei Sekunden aus, sieht so lange das ganze Feld und steigt dann weit entfernt wieder ein. Dort ist sie kurz geschützt.
- Jede Figur hat einen Sichtkreis. Wer darin ist, wird gesehen, auch hinter einer Hecke, alle anderen bleiben verborgen. Ein Pfeil an der eigenen Figur zeigt immer zur Beute, den Jäger sieht man erst, wenn er in den Kreis kommt.
- Alle sind gleich schnell. Nur wer seine Beute gerade im Sichtkreis hat, läuft etwas schneller (Jagdfieber). Wer flieht, muss also aus dem Kreis heraus.
- Sprinten kostet Ausdauer, der Balken unter der eigenen Figur zeigt sie an. Wer sich leer sprintet, muss kurz verschnaufen.
- Nach Ablauf der Zeit gewinnt der höchste Punktestand. Jede Runde hat ein neues Labyrinth.

## Items

In den Einstellungen lassen sich Items an- und ausschalten, ein neuer Raum beginnt mit Items. Dann liegen leuchtende Kisten im Labyrinth, die auch im Dunkeln zu sehen sind. Wer eine berührt und nichts auf Vorrat hat, bekommt ein zufälliges Item und löst es mit **E** aus. Was die anderen auf Vorrat haben, sieht man nicht. Nach ein paar Sekunden erscheint irgendwo eine neue Kiste.

Aufholhilfe: Wer vorne liegt, bekommt eher schwache Items, wer hinten liegt, eher starke (der Stern kommt beim Letzten etwa achtmal so oft wie beim Ersten).

| Item | Wirkung | Dauer |
| --- | --- | --- |
| Mondschein | Du siehst das ganze Feld. | 6 s |
| Tarnkappe | Niemand sieht dich, auch der Pfeil deines Jägers verschwindet. Fangen und gefangen werden geht weiter. | 6 s |
| Rakete | Du fliegst durch Hecken. Endet der Flug in einer Hecke, landest du in der Mitte deines Feldes. | 2,5 s |
| Stern | Du jagst beide anderen und kannst nicht gefangen werden. | 6 s |
| Blitz | Alle anderen stehen still, egal wo sie sind. | 1 s |
| Kehrtwende | Der Ring dreht sich um: Wer dich gejagt hat, ist jetzt deine Beute. | 8 s |
| Hecke | Hinter dir wächst der Gang zu. | 5 s |
| Falle | Unsichtbare Falle an deiner Stelle. Wer als Nächstes darüberläuft, steckt fest. | 2 s fest |
| Falsche Fährte | Der Pfeil deines Jägers zeigt auf eine falsche Stelle. | 8 s |

Was andere betrifft, wird allen angesagt, Stern, Blitz und Kehrtwende zusätzlich groß eingeblendet. Falle und falsche Fährte bleiben geheim: Davon erfährt nur, wer sie benutzt, und wer hineintappt oder hereinfällt. Wie lange eine Wirkung noch läuft, steht unten neben dem Vorrat.

## Einstellungen

Der Gastgeber stellt sie im Raum ein, die Mitspieler sehen sie. Sie gelten ab der nächsten Runde, und der Browser merkt sie sich für den nächsten Raum. Bis auf Items hat jede drei Stufen, die mittlere ist der Normalfall.

| Einstellung | Stufen | Wirkung |
| --- | --- | --- |
| Dauer | 2, 3, 5 Minuten | Länge einer Runde |
| Items | aus, an | Kisten mit Items im Labyrinth |
| Tempo | langsam, normal, schnell | Gehen und Sprinten mal 0,8 / 1 / 1,25 |
| Sichtkreis | klein, mittel, groß | Radius 2,5 / 3,5 / 5 Felder |
| Labyrinth | klein, mittel, groß | 16 × 10, 20 × 12 oder 24 × 14 Felder |
| Ausdauer | wenig, normal, viel | volle Ausdauer reicht 1,4 / 2,2 / 3,4 Sekunden Sprint |
| Auszeit | 1, 3, 5 Sekunden | so lange setzt aus, wer gefangen wurde |
| Jagdfieber | aus, normal, stark | wer seine Beute sieht, läuft 0 / 15 / 30 % schneller |

Mit den Bots gemessen: Ein großer Sichtkreis und abgeschaltetes Jagdfieber machen die Flucht leichter, es wird deutlich seltener gefangen. Ein kleiner Sichtkreis, hohes Tempo und starkes Jagdfieber machen die Runde hektischer.

## Technik

Eine statische Seite ohne Server und ohne Build-Schritt.

- `js/config.js`: alle Stellschrauben und die Stufen der Einstellungen
- `js/maze.js`, `js/physics.js`, `js/sim.js`, `js/bots.js`: Labyrinth, Bewegung, Regeln und Bots, ohne Browser-Abhängigkeiten
- `js/host.js`, `js/client.js`: Gastgeber und die Sicht eines Geräts auf das Spiel
- `js/net.js`: Verbindung zwischen den Geräten und Verschlüsselung
- `js/render.js`, `js/itemart.js`, `js/input.js`, `js/app.js`: Darstellung, Item-Symbole, Tastatur, Oberfläche

### Warum sich die Steuerung direkt anfühlt

Die eigene Figur wird bei jedem Tastendruck sofort im eigenen Browser bewegt, ohne auf den Gastgeber zu warten. Dessen gültiger Stand kommt 60-mal pro Sekunde zurück und wird mit den noch unbestätigten Eingaben abgeglichen. Beide rechnen mit demselben Code, deshalb stimmt die Vorhersage praktisch immer. Die Mitspieler werden mit einer kleinen Verzögerung zwischen zwei bekannten Ständen bewegt, damit sie auch bei unruhiger Verbindung flüssig laufen.

Im Labyrinth helfen zwei Dinge: Wer schräg gegen eine Hecke läuft, gleitet mit vollem Tempo an ihr entlang und biegt am nächsten Durchgang von selbst ab. Wer knapp neben einem Durchgang gegen die Hecke drückt, wird hineingeschoben.

### Verbindung

Zwei Wege, die sich ergänzen:

1. **Vermittler.** Jedes Gerät hängt an vier öffentlichen, kostenlosen MQTT-Diensten zugleich (EMQX, Eclipse, HiveMQ, Mosquitto). Darüber finden sich die Geräte. Es reicht, wenn einer erreichbar ist.
2. **Direktverbindung (WebRTC).** Haben sich Gastgeber und Mitspieler gefunden, bauen sie eine direkte Leitung auf, über die dann das Spiel läuft. Klappt das in einem Netz nicht, läuft das Spiel über die Vermittler weiter, nur etwas träger (20 statt 60 Spielstände pro Sekunde und ein Umweg).

Im Raum und unten links im Spiel steht, welcher Weg gerade gilt.

Weil die Vermittler öffentlich sind, ist dort alles verschlüsselt (AES-GCM). Schlüssel und Kanalname entstehen aus dem Raumcode. Die Vermittler sehen die IP-Adressen der Geräte und verschlüsselte Daten, aber keine Namen und keinen Spielstand. Ihre Adressen stehen oben in `js/net.js`.

## Entwickeln

```
npm install
npm test            # Labyrinth, Bewegung, Regeln, Bots, Abgleich über schlechte Leitungen
npm run test:e2e    # drei Browser spielen über lokale Vermittler, braucht Chrome
```

Zum Ausprobieren reicht ein beliebiger statischer Server im Projektordner, zum Beispiel `python3 -m http.server`.

## Fremde Bestandteile

- MQTT.js, MIT-Lizenz (`vendor/`)
- Schriften Grenze Gotisch und Alegreya Sans, SIL Open Font License (`fonts/`)
