# Hero Weather

Farmer-facing spray weather: a phone-first forecast (`index.html`) and a 7×7 spray-conditions map (`spray-map.html`). Scoring lives in `lib/spray-logic.js` so the UI and `/api/spray-window` stay on the same rules.

## Delta T (wet-bulb depression)

Delta T is **dry-bulb minus wet-bulb**, in °C. That is wet-bulb depression, not dew-point depression (`T − Td`). Wet-bulb sits between air temperature and dew point; using dew-point depression would overstate evaporation risk.

Open-Meteo already returns `temperature_2m`, `relative_humidity_2m`, and `dew_point_2m`. Wet-bulb is computed with **Stull (2011)** from air temperature (°C) and relative humidity (%):

```
Tw = T·atan(0.151977·√(RH + 8.313659))
   + atan(T + RH)
   − atan(RH − 1.676331)
   + 0.00391838·RH^1.5·atan(0.023101·RH)
   − 4.686035
```

Stull, R. (2011). *Wet-Bulb Temperature from Relative Humidity and Air Temperature.* Journal of Applied Meteorology and Climatology, 50, 2267–2269.

When humidity is missing, RH is recovered from dew point with Magnus-Tetens (Alduchov & Eskridge 1996):

```
es(T) = 6.112 · exp(17.67·T / (T + 243.5))   (hPa)
RH    = 100 · es(Td) / es(T)
```

Common ag-spray **display** bands (°C):

| Delta T | Label | Meaning |
| --- | --- | --- |
| below 2 | Too low | Inversion / droplet hang risk |
| 2 to 8 | Ideal | Usual spray window |
| 8 to 10 | Marginal | Watch evaporation |
| above 10 | Too dry | Evaporation risk |

Those labels are shown on the spray map hourly view and the point popup. They do **not** add a second go / caution / no-go pass. Map cells still use the existing Clarity (and product-label) rules, which already read Delta T. Product `min_delta_t` / `max_delta_t` stay on named settings for later use.

## Saved fields

Named locations (name, lat/lon, optional acres) live in browser `localStorage` only. No accounts.

- Module: `lib/saved-fields.js` (same UMD shape as `lib/spray-settings.js`, so it can move into a shared core later)
- Key: `hero.savedFields.v1` (schema version is in the key and in the document)
- Document: `{ schemaVersion, app, kind, activeId, fields[] }`
- Field: `{ id, name, lat, lon, acres, createdAt, updatedAt }`

On the spray map, **Fields** opens a panel to pick a saved field (centers the 7×7 map and loads its forecast), save the current map location, rename, or delete.

## Tests

```bash
npm test
node test-spray-map.js
```
