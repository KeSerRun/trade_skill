import { loadAppSettings } from "../scripts/lib/sqlite.mjs";

process.stdout.write(JSON.stringify(loadAppSettings()));
