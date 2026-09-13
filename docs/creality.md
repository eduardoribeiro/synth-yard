# Creality stock LAN connector

Select **Creality (Stock LAN)** for stock firmware exposing a WebSocket on port
9999 and HTTP file upload on port 80. No root access, Moonraker installation,
cloud account, access code, or API key is required.

## Compatibility

This implementation follows the protocol documented by
[ashimaryal25/printfarm](https://github.com/ashimaryal25/printfarm/tree/8bda3c2ba004040f4222152086898530ec60c5e0).
That project verifies the Ender 3 V3 KE on hardware and lists the K1, K1 Max,
and K1C as experimental. This integration has automated test coverage but has
not yet been verified on a physical printer. Treat stock K1 support as experimental
until status and a supervised print have been checked on your firmware.

K2/K2 Plus and CR-M4 are **not supported** by this connector; their network
interfaces differ. Sparkx i7 support has not been established. A Creality printer
with Moonraker installed can instead use the existing Klipper connector.

## Set up a K1

1. Connect the server and printer to the same LAN and reserve the printer's IP
   in your router. Ports 80 and 9999 must be reachable from the server.
2. In **Settings → Printer Models**, add model ID `k1`, label `Creality K1`,
   and connector **Creality (Stock LAN)**. Models are operator-managed, as for
   the other connectors; no database migration is needed.
3. Add a printer with that connector/model and its IP, for example `192.168.1.50`.
   An explicit HTTP port is accepted (`192.168.1.50:80`); WebSocket uses 9999.
4. Upload a plain `.gcode` file sliced for your K1 and assign it to model `k1`.
   Binary `.bgcode` and `.3mf` files are not accepted by this driver.
5. Check the displayed status against the printer screen. Clear the bed and use
   the existing **Set Ready** workflow to run a supervised first job.

For CSV import, register the model first, then use:

```csv
name,ip,type,model,group
K1_01,192.168.1.50,creality,k1,Creality Farm
```

## Behavior and troubleshooting

- Status polls combine fragmented WebSocket telemetry and map printing, paused,
  completed, failed, and aborted states to the existing fleet/job workflow.
  Missing or unrecognized states never make a printer available for dispatch.
- Progress uses the reported percentage, falling back to layer counts when the
  percentage is stuck at zero. Remaining time is an estimate from elapsed time
  and progress, not a slicer estimate.
- Upload uses `POST /upload/<filename>`, then `opGcodeFile` with
  `printprt:/usr/data/printer_data/gcodes/<filename>`. Firmware with different
  paths needs a separate compatibility change.
- Start success requires active telemetry with the exact uploaded filename.
  If start confirmation is lost, the scheduler does not resend the command;
  it checks that filename once more and otherwise holds the printer for operator
  confirmation. Upload failures before the start command retain normal retries.
- The driver implements confirmed cancellation with `stop: 1`. This does not
  add a new cancel button or change the application's existing job controls.
- Requests to the same printer are serialized to avoid exhausting the firmware's
  limited WebSocket connections. Close other LAN dashboards if connections fail.
- `GET /api/printers/<id>/raw-status` returns the collected protocol fields for
  troubleshooting. If K1 status differs from its screen, record those fields and
  the firmware version before attempting further jobs.

The protocol reference's MIT license is retained in
[licenses/printfarm-MIT.txt](licenses/printfarm-MIT.txt).
