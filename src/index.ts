import { env as globalEnv } from "cloudflare:workers";

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { z } from "zod";
import dayjs from "dayjs";

const locationSchema = z.object({
  _type: z.literal("location"),
  lat: z.number(),
  lon: z.number(),
});

const healthSchema = z.object({
  data: z.object({
    metrics: z
      .union([
        z.object({
          name: z.literal("sleep_analysis"),
          data: z
            .object({
              startDate: z.string(),
              endDate: z.string().nullish(),
              value: z.string(),
            })
            .array(),
        }),
        z.object({
          name: z.literal("heart_rate"),
          data: z
            .object({
              date: z.string(),
              Avg: z.number(),
            })
            .array(),
        }),
        z.object({
          name: z.literal("resting_heart_rate"),
          data: z
            .object({
              date: z.string(),
              qty: z.number(),
            })
            .array(),
        }),
      ])
      .array(),
  }),
});

const schema = z.union([
  locationSchema,
  healthSchema,
]);

const googleGeocodeSchema = z.object({
  results: z.array(z.object({
    formattedAddress: z.string(),
  })),
});
const googleTimezoneSchema = z.object({
  timeZoneId: z.string(),
});
const locationRespSchema = z.object({
  wide: z.string(),
  detailed: z.string(),
  timeZoneId: z.string(),
});
const getAddressesFromGeocode = async (lat: number, lon: number) => {
  const resp = await fetch(
    `https://geocode.googleapis.com/v4/geocode/location/${lat},${lon}?key=${globalEnv.GOOGLE_GEOCODE_KEY}`
  );
  const parsed = googleGeocodeSchema.parse(await resp.json());
  const wide = parsed.results[parsed.results.length - 2].formattedAddress;
  const detailed = parsed.results[0].formattedAddress;
  const timestamp = new Date().getTime() / 1000;
  const timezoneResp = await fetch(
    `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lon}&timestamp=${timestamp}&key=${globalEnv.GOOGLE_GEOCODE_KEY}`
  );
  const timeZoneId = googleTimezoneSchema.parse(await timezoneResp.json()).timeZoneId;
  return {
    wide,
    detailed,
    timeZoneId,
  }
};

const TOKEN = "To!cFvZw2ykXGdrXssePLQLPfEvP6-UT";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    let authed = request.headers.get("token") === TOKEN;
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.includes(" ")) {
      const token = authHeader.split(" ")[1];
      const decoded = atob(token);
      if (decoded.endsWith(`:${TOKEN}`)) {
        authed = true;
      }
    }

    switch (url.pathname) {
      case "/api/post":
        if (!authed) {
          return new Response("Token ERROR", { status: 403 });
        }
        const rawData = await request.json();
        const newData = schema.safeParse(rawData);
        if (!newData.success) {
          await env.STORAGE.put("illegal.json", JSON.stringify(rawData));
          return new Response("Illegal Data; ignore");
        }

        if ("lat" in newData.data && "lon" in newData.data) {
          const addresses = await getAddressesFromGeocode(newData.data.lat, newData.data.lon);
          await env.STORAGE.put("location.json", JSON.stringify(addresses));
        } else {
          await env.STORAGE.put("health.json", JSON.stringify(rawData));
        }
        return new Response("OK");


      case "/api/location":
        const rawLocation = await env.STORAGE.get("location.json");
        if (!rawLocation) {
          return new Response("Not found", { status: 404 });
        }
        const parsedLocation = locationRespSchema.safeParse(await rawLocation.json());
        if (!parsedLocation.success) {
          return new Response("Illegal Data", { status: 400 });
        }
        const { detailed, ...safeLocation } = parsedLocation.data;
        return Response.json(authed ? { detailed, ...safeLocation } : safeLocation);


      case "/api/health":
        const rawObj = await env.STORAGE.get("health.json");
        if (!rawObj) {
          return new Response("Not found", { status: 404 });
        }
        const gotData = healthSchema.safeParse(await rawObj.json());
        if (!gotData.success) {
          return new Response("Illegal Data", { status: 400 });
        }

        const result: any = {};

        const sleep = gotData.data.data.metrics.filter(
          (v) => v.name === "sleep_analysis",
        );
        if (0 < sleep.length) {
          const asleep = sleep[0].data
            .filter((v) => v.value === "Asleep")
            .map((v) => ({
              start: dayjs(v.startDate),
              end: v.endDate ? dayjs(v.endDate) : null,
            }));
          asleep.sort((a, b) =>
            b.end ? (a.end ? b.end.unix() - a.end.unix() : -1) : 1,
          );
          if (asleep[0]) {
            result["asleep"] = {
              start: asleep[0].start.toISOString(),
              end: asleep[0].end?.toISOString(),
            };
          }
        }

        const restingHeartRate = gotData.data.data.metrics.filter(
          (v) => v.name === "resting_heart_rate",
        );
        if (0 < restingHeartRate.length) {
          const restingHeartRates = restingHeartRate[0].data.map((v) => ({
            date: dayjs(v.date),
            qty: v.qty,
          }));
          restingHeartRates.sort((a, b) => b.date.unix() - a.date.unix());
          if (restingHeartRates[0]) {
            result["resting_heart_rate"] = {
              date: restingHeartRates[0].date.toISOString(),
              qty: restingHeartRates[0].qty,
            };
          }
        }

        const heartRate = gotData.data.data.metrics.filter(
          (v) => v.name === "heart_rate",
        );
        if (0 < heartRate.length) {
          const heartRates = heartRate[0].data.map((v) => ({
            date: dayjs(v.date),
            avg: v.Avg,
          }));
          heartRates.sort((a, b) => b.date.unix() - a.date.unix());
          if (heartRates[0]) {
            result["heart_rate"] = {
              date: heartRates[0].date.toISOString(),
              avg: heartRates[0].avg,
            };
          }
        }

        return Response.json(result);
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
