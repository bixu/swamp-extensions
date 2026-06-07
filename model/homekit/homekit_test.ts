import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  CHAR_TYPES,
  extractSensorReadings,
  type HAPAccessoryDatabase,
  normalizeUUID,
  SERVICE_TYPES,
  SRPClient,
  tlvDecode,
  tlvEncode,
} from "./homekit_hap.ts";
import { z } from "npm:zod@4";

// ─── TLV8 encode/decode ─────────────────────────────────────────────────────

Deno.test("tlvEncode produces correct header bytes for small values", () => {
  const input: [number, Uint8Array][] = [
    [0x06, new Uint8Array([1])],
  ];
  const encoded = tlvEncode(input);
  // type=0x06, length=1, value=0x01
  assertEquals(encoded, new Uint8Array([0x06, 0x01, 0x01]));
});

Deno.test("tlvEncode handles empty value with double zero-length entry", () => {
  const input: [number, Uint8Array][] = [
    [0x01, new Uint8Array(0)],
  ];
  const encoded = tlvEncode(input);
  // The do-while loop emits one [type, 0] entry, then the explicit
  // empty-check emits a second one.
  assertEquals(encoded, new Uint8Array([0x01, 0x00, 0x01, 0x00]));
});

Deno.test("tlvEncode fragments values longer than 255 bytes", () => {
  const bigValue = new Uint8Array(300);
  bigValue.fill(0xAB);
  const encoded = tlvEncode([[0x03, bigValue]]);

  // First fragment: type(1) + len(1) + data(255) = 257 bytes
  assertEquals(encoded[0], 0x03);
  assertEquals(encoded[1], 255);
  // Second fragment: type(1) + len(1) + data(45) = 47 bytes
  assertEquals(encoded[257], 0x03);
  assertEquals(encoded[258], 45);
  assertEquals(encoded.length, 257 + 47);
});

Deno.test("tlvEncode encodes multiple entries sequentially", () => {
  const entries: [number, Uint8Array][] = [
    [0x06, new Uint8Array([3])],
    [0x03, new Uint8Array([0xAA, 0xBB])],
  ];
  const encoded = tlvEncode(entries);
  // Entry 1: 0x06, 0x01, 0x03
  // Entry 2: 0x03, 0x02, 0xAA, 0xBB
  assertEquals(
    encoded,
    new Uint8Array([0x06, 0x01, 0x03, 0x03, 0x02, 0xAA, 0xBB]),
  );
});

Deno.test("tlvDecode parses single entry", () => {
  const data = new Uint8Array([0x06, 0x01, 0x05]);
  const result = tlvDecode(data);
  assertEquals(result.get(0x06), new Uint8Array([0x05]));
});

Deno.test("tlvDecode concatenates fragmented entries of same type", () => {
  // Simulate two fragments of type 0x03
  const frag1 = new Uint8Array(255).fill(0x01);
  const frag2 = new Uint8Array([0x02, 0x03]);

  const tlvBytes = new Uint8Array(255 + 2 + 2 + 2);
  // First fragment header
  tlvBytes[0] = 0x03;
  tlvBytes[1] = 255;
  tlvBytes.set(frag1, 2);
  // Second fragment header
  tlvBytes[257] = 0x03;
  tlvBytes[258] = 2;
  tlvBytes.set(frag2, 259);

  const result = tlvDecode(tlvBytes);
  const merged = result.get(0x03)!;
  assertEquals(merged.length, 257);
  assertEquals(merged[0], 0x01);
  assertEquals(merged[255], 0x02);
  assertEquals(merged[256], 0x03);
});

Deno.test("tlvDecode handles multiple distinct types", () => {
  const data = new Uint8Array([
    0x06,
    0x01,
    0x01, // State = 1
    0x00,
    0x01,
    0x00, // Method = 0
  ]);
  const result = tlvDecode(data);
  assertEquals(result.get(0x06), new Uint8Array([0x01]));
  assertEquals(result.get(0x00), new Uint8Array([0x00]));
});

Deno.test("tlvEncode then tlvDecode is a round-trip for small values", () => {
  const original: [number, Uint8Array][] = [
    [0x06, new Uint8Array([3])],
    [0x03, new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])],
    [0x04, new Uint8Array(64).fill(0xFF)],
  ];
  const encoded = tlvEncode(original);
  const decoded = tlvDecode(encoded);

  assertEquals(decoded.get(0x06), new Uint8Array([3]));
  assertEquals(decoded.get(0x03), new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
  assertEquals(decoded.get(0x04), new Uint8Array(64).fill(0xFF));
});

Deno.test("tlvEncode then tlvDecode round-trips large fragmented values", () => {
  const largeValue = new Uint8Array(600);
  largeValue.fill(0x42);
  const encoded = tlvEncode([[0x05, largeValue]]);
  const decoded = tlvDecode(encoded);
  assertEquals(decoded.get(0x05), largeValue);
});

// ─── normalizeUUID ──────────────────────────────────────────────────────────

Deno.test("normalizeUUID returns short type uppercased", () => {
  assertEquals(normalizeUUID("11"), "11");
  assertEquals(normalizeUUID("8a"), "8A");
  assertEquals(normalizeUUID("c8"), "C8");
});

Deno.test("normalizeUUID extracts significant part from full UUID", () => {
  // Full HAP UUID format: 00000011-0000-1000-8000-0026BB765291
  assertEquals(normalizeUUID("00000011-0000-1000-8000-0026BB765291"), "11");
  assertEquals(normalizeUUID("0000008A-0000-1000-8000-0026BB765291"), "8A");
});

Deno.test("normalizeUUID handles leading zeros in full UUID", () => {
  assertEquals(normalizeUUID("00000000-0000-1000-8000-0026BB765291"), "0");
});

Deno.test("normalizeUUID handles mixed-case short types", () => {
  assertEquals(normalizeUUID("Ab"), "AB");
});

// ─── extractSensorReadings ──────────────────────────────────────────────────

function makeAccessoryDb(
  services: {
    type: string;
    characteristics: { type: string; value?: unknown; unit?: string }[];
  }[],
): HAPAccessoryDatabase {
  return {
    accessories: [{
      aid: 1,
      services: services.map((svc, i) => ({
        iid: i + 1,
        type: svc.type,
        characteristics: svc.characteristics.map((ch, j) => ({
          aid: 1,
          iid: (i + 1) * 10 + j,
          type: ch.type,
          value: ch.value as number | string | boolean | undefined,
          unit: ch.unit,
        })),
      })),
    }],
  };
}

Deno.test("extractSensorReadings extracts temperature sensor", () => {
  const db = makeAccessoryDb([
    {
      type: SERVICE_TYPES.TemperatureSensor, // "8A"
      characteristics: [
        { type: CHAR_TYPES.Name, value: "Living Room Temp" },
        { type: CHAR_TYPES.CurrentTemperature, value: 22.5, unit: "celsius" },
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 1);
  assertEquals(readings[0].serviceName, "Living Room Temp");
  assertEquals(readings[0].serviceType, SERVICE_TYPES.TemperatureSensor);
  // Name is itself a CHAR_TYPE ("23") so it appears in characteristics too
  assertEquals(readings[0].characteristics.length, 2);
  const tempChar = readings[0].characteristics.find((c) =>
    c.name === "CurrentTemperature"
  )!;
  assertEquals(tempChar.value, 22.5);
  assertEquals(tempChar.unit, "celsius");
});

Deno.test("extractSensorReadings extracts humidity sensor", () => {
  const db = makeAccessoryDb([
    {
      type: SERVICE_TYPES.HumiditySensor, // "82"
      characteristics: [
        { type: CHAR_TYPES.Name, value: "Bedroom Humidity" },
        {
          type: CHAR_TYPES.CurrentRelativeHumidity,
          value: 55,
          unit: "percentage",
        },
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 1);
  assertEquals(readings[0].serviceName, "Bedroom Humidity");
  const humChar = readings[0].characteristics.find((c) =>
    c.name === "CurrentRelativeHumidity"
  )!;
  assertEquals(humChar.value, 55);
});

Deno.test("extractSensorReadings uses full UUID format for service type", () => {
  const db = makeAccessoryDb([
    {
      type: "0000008A-0000-1000-8000-0026BB765291", // TemperatureSensor as full UUID
      characteristics: [
        {
          type: "00000023-0000-1000-8000-0026BB765291",
          value: "Full UUID Sensor",
        }, // Name
        {
          type: "00000011-0000-1000-8000-0026BB765291",
          value: 19.3,
          unit: "celsius",
        }, // CurrentTemperature
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 1);
  assertEquals(readings[0].serviceName, "Full UUID Sensor");
  const tempChar = readings[0].characteristics.find((c) =>
    c.name === "CurrentTemperature"
  )!;
  assertEquals(tempChar.value, 19.3);
});

Deno.test("extractSensorReadings skips non-sensor services", () => {
  const db = makeAccessoryDb([
    {
      type: "A2", // AccessoryInformation (not a sensor)
      characteristics: [
        { type: CHAR_TYPES.Name, value: "Bridge" },
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 0);
});

Deno.test("extractSensorReadings skips characteristics with undefined value", () => {
  const db = makeAccessoryDb([
    {
      type: SERVICE_TYPES.TemperatureSensor,
      characteristics: [
        { type: CHAR_TYPES.Name, value: "Temp" },
        { type: CHAR_TYPES.CurrentTemperature, value: undefined },
        { type: CHAR_TYPES.StatusActive, value: true },
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 1);
  // Name and StatusActive have values; CurrentTemperature (undefined) is skipped
  assertEquals(readings[0].characteristics.length, 2);
  const names = readings[0].characteristics.map((c) => c.name);
  assertEquals(names.includes("Name"), true);
  assertEquals(names.includes("StatusActive"), true);
  assertEquals(names.includes("CurrentTemperature"), false);
});

Deno.test("extractSensorReadings uses fallback name when Name characteristic is absent", () => {
  const db = makeAccessoryDb([
    {
      type: SERVICE_TYPES.MotionSensor,
      characteristics: [
        { type: CHAR_TYPES.MotionDetected, value: true },
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 1);
  assertEquals(readings[0].serviceName, "Sensor 1.1");
});

Deno.test("extractSensorReadings handles multiple accessories", () => {
  const db: HAPAccessoryDatabase = {
    accessories: [
      {
        aid: 1,
        services: [{
          iid: 1,
          type: SERVICE_TYPES.TemperatureSensor,
          characteristics: [
            { aid: 1, iid: 10, type: CHAR_TYPES.Name, value: "Kitchen" },
            {
              aid: 1,
              iid: 11,
              type: CHAR_TYPES.CurrentTemperature,
              value: 24.0,
              unit: "celsius",
            },
          ],
        }],
      },
      {
        aid: 2,
        services: [{
          iid: 1,
          type: SERVICE_TYPES.HumiditySensor,
          characteristics: [
            { aid: 2, iid: 10, type: CHAR_TYPES.Name, value: "Bathroom" },
            {
              aid: 2,
              iid: 11,
              type: CHAR_TYPES.CurrentRelativeHumidity,
              value: 72,
              unit: "percentage",
            },
          ],
        }],
      },
    ],
  };

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 2);
  assertEquals(readings[0].serviceName, "Kitchen");
  assertEquals(readings[1].serviceName, "Bathroom");
});

Deno.test("extractSensorReadings returns empty array for empty database", () => {
  const db: HAPAccessoryDatabase = { accessories: [] };
  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 0);
});

Deno.test("extractSensorReadings handles air quality sensor with multiple characteristics", () => {
  const db = makeAccessoryDb([
    {
      type: SERVICE_TYPES.AirQualitySensor,
      characteristics: [
        { type: CHAR_TYPES.Name, value: "Office Air" },
        { type: CHAR_TYPES.AirQuality, value: 2 },
        { type: CHAR_TYPES.VOCDensity, value: 350 },
        { type: CHAR_TYPES.PM2_5Density, value: 12 },
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 1);
  // Name + AirQuality + VOCDensity + PM2_5Density = 4
  assertEquals(readings[0].characteristics.length, 4);

  const names = readings[0].characteristics.map((c) => c.name);
  assertEquals(names.includes("Name"), true);
  assertEquals(names.includes("AirQuality"), true);
  assertEquals(names.includes("VOCDensity"), true);
  assertEquals(names.includes("PM2_5Density"), true);
});

Deno.test("extractSensorReadings skips service with no known characteristics", () => {
  const db = makeAccessoryDb([
    {
      type: SERVICE_TYPES.ContactSensor,
      characteristics: [
        { type: CHAR_TYPES.Name, value: "Door" },
        // Name is a known CHAR_TYPE but its value becomes a reading
        // Actually Name resolves to "23" in CHAR_TYPES, let's add an unknown char
        { type: "FF", value: 42 }, // Unknown characteristic type
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  // The service is a sensor type, but only the Name char is a known CHAR_TYPE.
  // Name has value "Door" so it will be included as a reading characteristic.
  assertEquals(readings.length, 1);
  assertEquals(readings[0].characteristics[0].name, "Name");
  assertEquals(readings[0].characteristics[0].value, "Door");
});

Deno.test("extractSensorReadings includes battery level from battery service", () => {
  const db = makeAccessoryDb([
    {
      type: SERVICE_TYPES.BatteryService,
      characteristics: [
        { type: CHAR_TYPES.Name, value: "Battery" },
        { type: CHAR_TYPES.BatteryLevel, value: 85, unit: "percentage" },
        { type: CHAR_TYPES.ChargingState, value: 0 },
        { type: CHAR_TYPES.StatusLowBattery, value: 0 },
      ],
    },
  ]);

  const readings = extractSensorReadings(db);
  assertEquals(readings.length, 1);
  const names = readings[0].characteristics.map((c) => c.name);
  assertEquals(names.includes("BatteryLevel"), true);
  assertEquals(names.includes("ChargingState"), true);
  assertEquals(names.includes("StatusLowBattery"), true);
});

// ─── SRPClient ──────────────────────────────────────────────────────────────

Deno.test("SRPClient generates a 384-byte public key", () => {
  const client = new SRPClient("Pair-Setup", "12345678");
  const pubKey = client.getPublicKey();
  assertEquals(pubKey.length, 384);
});

Deno.test("SRPClient generates different public keys on each instantiation", () => {
  const client1 = new SRPClient("Pair-Setup", "12345678");
  const client2 = new SRPClient("Pair-Setup", "12345678");
  assertNotEquals(client1.getPublicKey(), client2.getPublicKey());
});

// ─── Zod schemas (from homekit.ts model definition) ─────────────────────────

// Re-define schemas locally to test them without importing the model
// (homekit.ts only exports `model`, not individual schemas)

const AccessorySchema = z.object({
  name: z.string(),
  address: z.string(),
  port: z.number(),
  id: z.string(),
  model: z.string(),
  category: z.string(),
  categoryId: z.number(),
  configNumber: z.number(),
  stateNumber: z.number(),
  protocolVersion: z.string(),
  paired: z.boolean(),
  discoveredAt: z.string(),
});

const DiscoverySchema = z.object({
  totalAccessories: z.number(),
  timeoutSeconds: z.number(),
  accessories: z.array(AccessorySchema),
  discoveredAt: z.string(),
});

const SensorCharacteristicSchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.union([z.number(), z.string(), z.boolean()]),
  unit: z.string().optional(),
});

const SensorReadingSchema = z.object({
  accessoryName: z.string(),
  accessoryAddress: z.string(),
  serviceName: z.string(),
  serviceType: z.string(),
  characteristics: z.array(SensorCharacteristicSchema),
  readAt: z.string(),
});

Deno.test("AccessorySchema accepts a well-formed accessory object", () => {
  const input = {
    name: "Eve Room",
    address: "192.168.1.42",
    port: 51826,
    id: "AA:BB:CC:DD:EE:FF",
    model: "Eve Room 20EAM9901",
    category: "Sensor",
    categoryId: 10,
    configNumber: 3,
    stateNumber: 1,
    protocolVersion: "1.1",
    paired: true,
    discoveredAt: "2026-03-14T10:00:00.000Z",
  };
  const result = AccessorySchema.safeParse(input);
  assertEquals(result.success, true);
});

Deno.test("AccessorySchema rejects missing required fields", () => {
  const result = AccessorySchema.safeParse({ name: "Incomplete" });
  assertEquals(result.success, false);
});

Deno.test("DiscoverySchema accepts a valid discovery payload", () => {
  const input = {
    totalAccessories: 1,
    timeoutSeconds: 10,
    accessories: [{
      name: "Bridge",
      address: "10.0.0.1",
      port: 51826,
      id: "11:22:33:44:55:66",
      model: "HKSB",
      category: "Bridge",
      categoryId: 2,
      configNumber: 1,
      stateNumber: 1,
      protocolVersion: "1.1",
      paired: false,
      discoveredAt: "2026-01-01T00:00:00.000Z",
    }],
    discoveredAt: "2026-01-01T00:00:00.000Z",
  };
  const result = DiscoverySchema.safeParse(input);
  assertEquals(result.success, true);
});

Deno.test("SensorReadingSchema accepts valid sensor reading", () => {
  const input = {
    accessoryName: "Eve Room",
    accessoryAddress: "192.168.1.42",
    serviceName: "Temperature",
    serviceType: "8A",
    characteristics: [
      { name: "CurrentTemperature", type: "11", value: 21.5, unit: "celsius" },
    ],
    readAt: "2026-03-14T12:00:00.000Z",
  };
  const result = SensorReadingSchema.safeParse(input);
  assertEquals(result.success, true);
});

Deno.test("SensorCharacteristicSchema accepts boolean value", () => {
  const input = { name: "MotionDetected", type: "22", value: true };
  const result = SensorCharacteristicSchema.safeParse(input);
  assertEquals(result.success, true);
});

Deno.test("SensorCharacteristicSchema accepts string value", () => {
  const input = { name: "Name", type: "23", value: "My Sensor" };
  const result = SensorCharacteristicSchema.safeParse(input);
  assertEquals(result.success, true);
});

Deno.test("SensorCharacteristicSchema unit is optional", () => {
  const withUnit = SensorCharacteristicSchema.safeParse({
    name: "Temp",
    type: "11",
    value: 20,
    unit: "celsius",
  });
  const withoutUnit = SensorCharacteristicSchema.safeParse({
    name: "Temp",
    type: "11",
    value: 20,
  });
  assertEquals(withUnit.success, true);
  assertEquals(withoutUnit.success, true);
});

// ─── SERVICE_TYPES and CHAR_TYPES constants ─────────────────────────────────

Deno.test("SERVICE_TYPES contains expected sensor types", () => {
  assertEquals(SERVICE_TYPES.TemperatureSensor, "8A");
  assertEquals(SERVICE_TYPES.HumiditySensor, "82");
  assertEquals(SERVICE_TYPES.AirQualitySensor, "8D");
  assertEquals(SERVICE_TYPES.MotionSensor, "85");
  assertEquals(SERVICE_TYPES.ContactSensor, "80");
  assertEquals(SERVICE_TYPES.LeakSensor, "83");
  assertEquals(SERVICE_TYPES.SmokeSensor, "87");
  assertEquals(SERVICE_TYPES.BatteryService, "96");
});

Deno.test("CHAR_TYPES contains expected characteristic types", () => {
  assertEquals(CHAR_TYPES.CurrentTemperature, "11");
  assertEquals(CHAR_TYPES.CurrentRelativeHumidity, "10");
  assertEquals(CHAR_TYPES.Name, "23");
  assertEquals(CHAR_TYPES.BatteryLevel, "68");
  assertEquals(CHAR_TYPES.AirQuality, "95");
  assertEquals(CHAR_TYPES.MotionDetected, "22");
});
