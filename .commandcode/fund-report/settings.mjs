import { loadAppSettings } from "../skills/fund-trading/scripts/lib/sqlite.mjs";

process.stdout.write(JSON.stringify(loadAppSettings()));
