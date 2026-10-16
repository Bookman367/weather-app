'use strict';

// Frozen field-local time: 1:00 PM CDT on 16 Oct 2026.
const NOW_LOCAL = '2026-10-16T13:00';
const TODAY = '2026-10-16';

function hour(time, status) {
  return { time, spray: { status, reasons: [] } };
}

function hoursFrom(spec) {
  // spec: { '2026-10-16T13:00': 'favorable', ... }
  return Object.keys(spec).sort().map(time => hour(time, spec[time]));
}

const GO_STARTS_SOON = hoursFrom({
  '2026-10-16T12:00': 'no-good',
  '2026-10-16T13:00': 'no-good',
  '2026-10-16T14:00': 'favorable',
  '2026-10-16T15:00': 'favorable',
  '2026-10-16T16:00': 'caution'
});

const GO_STARTS_LATER = hoursFrom({
  '2026-10-16T13:00': 'no-good',
  '2026-10-16T14:00': 'caution',
  '2026-10-16T16:00': 'favorable',
  '2026-10-16T17:00': 'favorable'
});

const GO_ENDS_SOON = hoursFrom({
  '2026-10-16T12:00': 'favorable',
  '2026-10-16T13:00': 'favorable',
  '2026-10-16T14:00': 'favorable',
  '2026-10-16T15:00': 'no-good',
  '2026-10-16T16:00': 'no-good'
});

const GO_ENDS_THIS_HOUR = hoursFrom({
  '2026-10-16T13:00': 'favorable',
  '2026-10-16T14:00': 'caution',
  '2026-10-16T15:00': 'no-good'
});

const GO_ALL_AFTERNOON = hoursFrom({
  '2026-10-16T13:00': 'favorable',
  '2026-10-16T14:00': 'favorable',
  '2026-10-16T15:00': 'favorable',
  '2026-10-16T16:00': 'favorable',
  '2026-10-16T17:00': 'favorable'
});

const GO_TOMORROW_ONLY = hoursFrom({
  '2026-10-16T13:00': 'no-good',
  '2026-10-16T14:00': 'caution',
  '2026-10-17T07:00': 'favorable',
  '2026-10-17T08:00': 'favorable'
});

const NWS_LINCOLN_MIXED = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'https://api.weather.gov/alerts/freeze-watch',
      properties: {
        id: 'urn:oid:2.49.0.1.840.0.freeze',
        event: 'Freeze Watch',
        headline: 'Freeze Watch issued October 15 at 1:18PM CDT until October 17 at 8:00AM CDT by NWS Omaha',
        severity: 'Severe',
        urgency: 'Future',
        ends: '2026-10-17T08:00:00-05:00',
        areaDesc: 'Lancaster, NE'
      }
    },
    {
      id: 'https://api.weather.gov/alerts/frost',
      properties: {
        event: 'Frost Advisory',
        headline: 'Frost Advisory issued October 16 at 3:00AM CDT until October 16 at 8:00AM CDT by NWS Omaha',
        severity: 'Minor',
        urgency: 'Expected',
        expires: '2026-10-16T13:00:00-05:00',
        areaDesc: 'Lancaster, NE'
      }
    },
    {
      id: 'https://api.weather.gov/alerts/svr',
      properties: {
        event: 'Severe Thunderstorm Warning',
        headline: 'Severe Thunderstorm Warning for Lancaster County',
        severity: 'Extreme',
        urgency: 'Immediate',
        ends: '2026-10-16T14:30:00-05:00',
        areaDesc: 'Lancaster, NE'
      }
    },
    {
      id: 'https://api.weather.gov/alerts/blank',
      properties: {
        event: '   ',
        severity: 'Unknown'
      }
    }
  ]
};

const NWS_EMPTY = { type: 'FeatureCollection', features: [] };

module.exports = {
  NOW_LOCAL,
  TODAY,
  hour,
  hoursFrom,
  GO_STARTS_SOON,
  GO_STARTS_LATER,
  GO_ENDS_SOON,
  GO_ENDS_THIS_HOUR,
  GO_ALL_AFTERNOON,
  GO_TOMORROW_ONLY,
  NWS_LINCOLN_MIXED,
  NWS_EMPTY
};
