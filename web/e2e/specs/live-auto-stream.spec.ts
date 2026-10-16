/**
 * Auto live stream selection in the single-camera view.
 *
 * go2rtc is mocked per stream. A failing stream answers MSE codec
 * negotiation with go2rtc's "codecs not matched" error, the one ladder
 * trigger Chromium reproduces without real media. A healthy stream
 * answers negotiation and then sends nothing, so it waits quietly.
 */
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { test, expect } from "../fixtures/frigate-test";
import { LivePage } from "../pages/live.page";

// the mocked profile is admin, so useUserPersistence keys are namespaced
const STREAM_KEY = "front_door-stream:admin";
// go2rtc 1.9's reply for an H.265 stream to a browser without H.265 MSE
const CODEC_ERROR =
  "mse: streams: codecs not matched: video:H265 => video:H264, audio:AAC, audio:PCMA, audio:PCMU, audio:OPUS";

const CONFIG = {
  go2rtc: {
    streams: {
      front_door: ["rtsp://127.0.0.1:8554/front_door"],
      front_door_sub: ["rtsp://127.0.0.1:8554/front_door_sub"],
      backyard: ["rtsp://127.0.0.1:8554/backyard"],
    },
    webrtc: { candidates: [], ice_servers: [] },
  },
  cameras: {
    front_door: {
      live: { streams: { Sub: "front_door_sub" } },
    },
  },
};

test.use({ expectedErrors: [/MSE error 'mse-codec'/] });

async function writeIdb(page: Page, entries: Record<string, unknown>) {
  await page.evaluate(async (data) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("keyval-store", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("keyval");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction("keyval", "readwrite");
        const store = tx.objectStore("keyval");
        Object.entries(data).forEach(([key, value]) => store.put(value, key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, entries);
}

async function readIdb(page: Page, key: string) {
  return page.evaluate(async (target) => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("keyval-store", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("keyval");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction("keyval", "readonly");
        const get = tx.objectStore("keyval").get(target);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
    });
  }, key);
}

// records the src of every MSE socket in open order
async function mockGo2rtc(
  page: Page,
  failing: string[] = [],
  // one error for every failing stream, or one per stream
  error: string | Record<string, string> = CODEC_ERROR,
) {
  const opened: string[] = [];

  await page.routeWebSocket("**/live/mse/api/ws**", (ws) => {
    const src = new URL(ws.url()).searchParams.get("src") ?? "";
    opened.push(src);

    ws.onMessage((message) => {
      const msg = JSON.parse(message.toString());
      if (msg.type !== "mse") {
        return;
      }

      ws.send(
        JSON.stringify(
          failing.includes(src)
            ? {
                type: "error",
                value: typeof error === "string" ? error : error[src],
              }
            : { type: "mse", value: 'video/mp4; codecs="avc1.640029"' },
        ),
      );
    });
  });

  await page.route("**/api/go2rtc/streams/**", (route) =>
    route.fulfill({
      json: {
        producers: [{ medias: ["video, recvonly, H264"] }],
        consumers: [],
      },
    }),
  );

  return opened;
}

async function openDesktopSettings(page: Page) {
  const live = new LivePage(page, true);
  await expect(live.backButton).toBeVisible({ timeout: 10_000 });
  await page.locator("button:has(svg)").last().click();
  const menu = page.locator('[role="menu"], [data-radix-menu-content]').first();
  await expect(menu).toBeVisible({ timeout: 3_000 });
  return menu;
}

function streamTrigger(menu: Locator) {
  return menu
    .locator('div:has(> label[for="streaming-method"]) [role="combobox"]')
    .first();
}

test.describe("Auto live stream @mobile", () => {
  test("a codec error on the main stream moves Auto to the sub stream", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(frigateApp.page, ["front_door"]);

    await frigateApp.goto("/#front_door");

    await expect
      .poll(() => opened, { timeout: 10_000 })
      .toContain("front_door_sub");
    expect(opened[0]).toBe("front_door");
  });
});

test.describe("Transcoded live stream @mobile", () => {
  test("a pinned transcoded stream plays over MSE", async ({ frigateApp }) => {
    // go2rtc.streams lists only yaml streams; transcoded ones are generated
    await frigateApp.installDefaults({
      config: {
        ...CONFIG,
        cameras: {
          front_door: {
            live: {
              streams: {
                Sub: "front_door_sub",
                "720p": "front_door_transcode_720p",
              },
              transcode: {
                enabled: true,
                source: "front_door",
                qualities: [{ height: 720, bitrate: 1200 }],
              },
            },
          },
        },
      },
    });
    const opened = await mockGo2rtc(frigateApp.page);

    await frigateApp.goto("/");
    await writeIdb(frigateApp.page, {
      [STREAM_KEY]: "front_door_transcode_720p",
    });
    await frigateApp.goto("/#front_door");

    await expect
      .poll(() => opened, { timeout: 10_000 })
      .toContain("front_door_transcode_720p");
  });
});

test.describe("Auto live stream selector", () => {
  test.beforeEach(({ frigateApp }) => {
    test.skip(frigateApp.isMobile, "Desktop dropdown only");
  });

  test("no saved stream opens Auto on the first stream", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(frigateApp.page);

    await frigateApp.goto("/#front_door");

    await expect.poll(() => opened[0], { timeout: 10_000 }).toBe("front_door");
    const menu = await openDesktopSettings(frigateApp.page);
    await expect(streamTrigger(menu)).toHaveText("Auto · front_door");
  });

  test("a codec error shows the codec reason", async ({ frigateApp }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(frigateApp.page, ["front_door"]);

    await frigateApp.goto("/#front_door");

    await expect
      .poll(() => opened, { timeout: 10_000 })
      .toContain("front_door_sub");
    const menu = await openDesktopSettings(frigateApp.page);
    await expect(streamTrigger(menu)).toHaveText("Auto · Sub");
    await expect(
      menu.getByText(/because this browser can't play a higher-quality stream/),
    ).toBeVisible();
    await expect(
      menu.getByText(
        "Use a browser that can play H.265 video, such as Safari.",
      ),
    ).toBeVisible();
  });

  test("trying the highest quality retries the top stream", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(frigateApp.page, ["front_door"]);

    await frigateApp.goto("/#front_door");

    await expect
      .poll(() => opened, { timeout: 10_000 })
      .toContain("front_door_sub");
    const menu = await openDesktopSettings(frigateApp.page);
    const beforeRetry = opened.length;
    await menu.getByRole("button", { name: "Try highest quality" }).click();

    await expect
      .poll(() => opened.slice(beforeRetry), { timeout: 10_000 })
      .toContain("front_door");
  });

  test("a pinned main takes the legacy fallback instead of stepping down", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(frigateApp.page, ["front_door"]);

    await frigateApp.goto("/");
    await writeIdb(frigateApp.page, { [STREAM_KEY]: "front_door" });
    await frigateApp.goto("/#front_door");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(
      menu.getByText(/Live view is in low-bandwidth mode/),
    ).toBeVisible({ timeout: 10_000 });
    expect(opened).not.toContain("front_door_sub");
  });

  test("selecting Auto clears the saved stream", async ({ frigateApp }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    await mockGo2rtc(frigateApp.page);

    await frigateApp.goto("/");
    await writeIdb(frigateApp.page, { [STREAM_KEY]: "front_door_sub" });
    await frigateApp.goto("/#front_door");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(streamTrigger(menu)).toHaveText("Sub");
    await streamTrigger(menu).click();
    await frigateApp.page.getByRole("option", { name: /^Auto/ }).click();

    await expect.poll(() => readIdb(frigateApp.page, STREAM_KEY)).toBeNull();
  });

  test("a stale pin falls back to Auto", async ({ frigateApp }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(frigateApp.page);

    await frigateApp.goto("/");
    await writeIdb(frigateApp.page, { [STREAM_KEY]: "removed_stream" });
    await frigateApp.goto("/#front_door");

    await expect.poll(() => readIdb(frigateApp.page, STREAM_KEY)).toBeNull();
    await expect.poll(() => opened[0], { timeout: 10_000 }).toBe("front_door");
  });

  test("a single-stream camera offers no Auto", async ({ frigateApp }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    await mockGo2rtc(frigateApp.page);

    await frigateApp.goto("/#backyard");

    const menu = await openDesktopSettings(frigateApp.page);
    await streamTrigger(menu).click();
    await expect(
      frigateApp.page.getByRole("option", { name: "backyard" }),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByRole("option", { name: /^Auto/ }),
    ).toHaveCount(0);
  });

  test("Reset stream at the floor returns to the top stream", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(frigateApp.page, [
      "front_door",
      "front_door_sub",
    ]);

    await frigateApp.goto("/#front_door");

    await expect
      .poll(() => opened, { timeout: 10_000 })
      .toContain("front_door_sub");
    expect(opened[0]).toBe("front_door");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(streamTrigger(menu)).toHaveText("Auto · Low bandwidth");
    await expect(
      menu.getByText(/Playing the low-bandwidth feed/),
    ).toBeVisible();

    const beforeReset = opened.length;
    await menu.getByRole("button", { name: "Reset stream" }).click();

    // leaving the floor changes the stream and the mode in one render,
    // which must still open each stream exactly once
    await expect
      .poll(() => opened.slice(beforeReset), { timeout: 10_000 })
      .toEqual(["front_door", "front_door_sub"]);
  });
});

test.describe("Live stream errors", () => {
  test.use({ expectedErrors: [/MSE error 'startup'/] });

  test.beforeEach(({ frigateApp }) => {
    test.skip(frigateApp.isMobile, "Desktop dropdown only");
  });

  test("the low-bandwidth notice shows go2rtc's error", async ({
    frigateApp,
  }) => {
    const sourceError =
      "mse: streams: exec/rtsp\n[hwupload @ 0x5562] A hardware device reference is required to upload frames to.";
    await frigateApp.installDefaults({ config: CONFIG });
    await mockGo2rtc(frigateApp.page, ["backyard"], sourceError);

    await frigateApp.goto("/#backyard");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(
      menu.getByText(/Live view is in low-bandwidth mode/),
    ).toBeVisible({ timeout: 10_000 });
    await expect(menu.locator("pre")).toHaveText(sourceError);
  });

  test("Auto at the low-bandwidth floor shows go2rtc's error", async ({
    frigateApp,
  }) => {
    const sourceError =
      "mse: streams: dial tcp 10.0.0.1:554: connect: connection refused";
    await frigateApp.installDefaults({ config: CONFIG });
    const opened = await mockGo2rtc(
      frigateApp.page,
      ["front_door", "front_door_sub"],
      sourceError,
    );

    await frigateApp.goto("/#front_door");

    // auto steps down through every stream before the floor
    await expect
      .poll(() => opened, { timeout: 10_000 })
      .toContain("front_door_sub");
    const menu = await openDesktopSettings(frigateApp.page);
    await expect(streamTrigger(menu)).toHaveText("Auto · Low bandwidth", {
      timeout: 10_000,
    });
    await expect(menu.locator("pre")).toHaveText(sourceError);
  });

  test("the floor keeps go2rtc's error when the WebRTC check finishes", async ({
    frigateApp,
  }) => {
    const sourceError =
      "mse: streams: dial tcp 10.0.0.1:554: connect: connection refused";
    await frigateApp.installDefaults({
      config: {
        ...CONFIG,
        go2rtc: {
          ...CONFIG.go2rtc,
          webrtc: { candidates: ["192.168.1.10:8555"], ice_servers: [] },
        },
      },
    });
    // hold the WebRTC check open until auto has reached the floor. The check
    // starts over on each stream auto plays, so keep its socket per stream.
    const probes = new Map<string, WebSocketRoute>();
    await frigateApp.page.routeWebSocket("**/live/webrtc/api/ws**", (ws) => {
      probes.set(new URL(ws.url()).searchParams.get("src") ?? "", ws);
    });
    let verdictSeen = false;
    frigateApp.page.on("console", (message) => {
      if (message.text().includes("WebRTC unavailable")) {
        verdictSeen = true;
      }
    });
    await mockGo2rtc(
      frigateApp.page,
      ["front_door", "front_door_sub"],
      sourceError,
    );

    await frigateApp.goto("/#front_door");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(streamTrigger(menu)).toHaveText("Auto · Low bandwidth", {
      timeout: 10_000,
    });
    expect(verdictSeen).toBe(false);
    await expect.poll(() => probes.has("front_door_sub")).toBe(true);

    // an answer the browser rejects ends the check right away
    probes
      .get("front_door_sub")!
      .send(JSON.stringify({ type: "webrtc/answer", value: "not an sdp" }));
    // well before the check's own 5 second timeout
    await expect.poll(() => verdictSeen, { timeout: 3_000 }).toBe(true);
    await expect(menu.locator("pre")).toHaveText(sourceError);
  });

  test("Reset stream clears go2rtc's error", async ({ frigateApp }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    const failing = ["backyard"];
    await mockGo2rtc(
      frigateApp.page,
      failing,
      "mse: streams: dial tcp 10.0.0.1:554: connect: connection refused",
    );

    await frigateApp.goto("/#backyard");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(menu.locator("pre")).toHaveText(/connection refused/, {
      timeout: 10_000,
    });

    // the camera is reachable again
    failing.length = 0;
    await menu.getByRole("button", { name: "Reset stream" }).click();

    await expect(
      menu.getByText(/Live view is in low-bandwidth mode/),
    ).toBeHidden({ timeout: 10_000 });
    await expect(menu.locator("pre")).toHaveCount(0);
  });
});

test.describe("Unsupported video codec", () => {
  test.use({ expectedErrors: [/MSE error '(mse-codec|startup)'/] });

  test.beforeEach(({ frigateApp }) => {
    test.skip(frigateApp.isMobile, "Desktop dropdown only");
  });

  test("the low-bandwidth notice names the codec and the fixes", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    await mockGo2rtc(frigateApp.page, ["backyard"]);

    await frigateApp.goto("/#backyard");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(
      menu.getByText(
        "Live view is in low-bandwidth mode because this browser can't play this camera's H.265 video.",
      ),
    ).toBeVisible({ timeout: 10_000 });
    for (const fix of [
      "Set the camera's video codec to H.264 in its own settings (recommended).",
      "In the Frigate config, use an H.264 stream for live view, such as the camera's substream, or transcode to H.264 with go2rtc.",
      "Use a browser that can play H.265 video, such as Safari.",
    ]) {
      await expect(menu.getByText(fix, { exact: true })).toBeVisible();
    }
    await expect(
      menu.getByRole("link", { name: "Read the documentation" }).last(),
    ).toHaveAttribute("href", /troubleshooting\/go2rtc/);
    // the friendly text replaces go2rtc's own message
    await expect(menu.locator("pre")).toHaveCount(0);
  });

  test("a later error on a lower stream replaces the codec hint", async ({
    frigateApp,
  }) => {
    const subError =
      "mse: streams: dial tcp 10.0.0.1:554: connect: connection refused";
    await frigateApp.installDefaults({ config: CONFIG });
    await mockGo2rtc(frigateApp.page, ["front_door", "front_door_sub"], {
      front_door: CODEC_ERROR,
      front_door_sub: subError,
    });

    await frigateApp.goto("/#front_door");

    // auto skipped the H.265 main stream, then the sub stream failed too
    const menu = await openDesktopSettings(frigateApp.page);
    await expect(streamTrigger(menu)).toHaveText("Auto · Low bandwidth", {
      timeout: 10_000,
    });
    await expect(menu.locator("pre")).toHaveText(subError);
    await expect(menu.getByText(/can't play this camera's/)).toHaveCount(0);
  });

  test("a codec error without codec names still explains the fixes", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: CONFIG });
    await mockGo2rtc(
      frigateApp.page,
      ["backyard"],
      "mse: streams: codecs not matched",
    );

    await frigateApp.goto("/#backyard");

    const menu = await openDesktopSettings(frigateApp.page);
    await expect(
      menu.getByText(
        "Live view is in low-bandwidth mode because this browser can't play this camera's video codec.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      menu.getByText("Use a browser that can play this camera's video."),
    ).toBeVisible();
  });
});
