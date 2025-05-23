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

const schema = z.object({
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
                    data: z.object({
                        date: z.string(),
                        Avg: z.number(),
                    })
                        .array(),
                }),
            ])
            .array(),
    }),
});

export default {
    async fetch(request, env, ctx): Promise<Response> {
        const url = new URL(request.url);
        switch (url.pathname) {
            case "/api/post":
                if (
                    request.headers.get("token") !== "To!cFvZw2ykXGdrXssePLQLPfEvP6-UT"
                ) {
                    return new Response("Token ERROR", { status: 403 });
                }
                const rawData = await request.json();
                const newData = schema.safeParse(rawData);
                if (!newData.success) {
                    await env.STORAGE.put("illegal.json", JSON.stringify(rawData));
                    return new Response("Illegal Data", { status: 400 });
                }
                await env.STORAGE.put("latest.json", JSON.stringify(newData.data));
                return new Response("OK");
            case "/api/data":
                const rawObj = await env.STORAGE.get("latest.json");
                if (!rawObj) {
                    return new Response("Not found", { status: 404 });
                }
                const gotData = schema.safeParse(await rawObj.json());
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
                    result["asleep"] = {
                        start: asleep[0].start.toISOString(),
                        end: asleep[0].end?.toISOString(),
                    };
                }

                const heartRate = gotData.data.data.metrics.filter(
                    (v) => v.name === "heart_rate",
                );
                if (0 < heartRate.length) {
                    const heartRates = heartRate[0]
                        .data
                        .map((v) => ({ date: dayjs(v.date), avg: v.Avg }));
                    heartRates.sort((a, b) => b.date.unix() - a.date.unix());
                    result["heart_rate"] = {
                        date: heartRates[0].date.toISOString(),
                        avg: heartRates[0].avg,
                    };
                }

                return Response.json(result);
            default:
                return new Response("Not Found", { status: 404 });
        }
    },
} satisfies ExportedHandler<Env>;
