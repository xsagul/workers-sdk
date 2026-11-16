import net from "node:net";
import { describe, test } from "vitest";
import { serialiseError } from "../../../api/startDevWorker/events";
import { ProxyController } from "../../../api/startDevWorker/ProxyController";
import { FakeBus } from "../../helpers/fake-bus";
import { mockConsoleMethods } from "../../helpers/mock-console";
import { useTeardown } from "../../helpers/teardown";
import { unusable } from "../../helpers/unusable";
import type {
	SerializedError,
	StartDevWorkerOptions,
} from "../../../api/startDevWorker";
import type { AddressInfo } from "node:net";

function makeProxyConfig(inspectorPort: number): StartDevWorkerOptions {
	return {
		name: "test-worker",
		compatibilityDate: "2025-10-10",
		complianceRegion: undefined,
		entrypoint: "NOT_REAL",
		projectRoot: "NOT_REAL",
		build: unusable<StartDevWorkerOptions["build"]>(),
		legacy: {},
		dev: {
			persist: "./persist",
			remote: false,
			server: {
				hostname: "127.0.0.1",
				port: 0,
			},
			inspector: {
				hostname: "127.0.0.1",
				port: inspectorPort,
			},
		},
	};
}

describe("ProxyController", () => {
	mockConsoleMethods();
	const teardown = useTeardown();

	test("ProxyWorker error reports preserve message/name/stack across the JSON channel", async ({
		expect,
	}) => {
		// Regression test for https://github.com/cloudflare/workers-sdk/issues/14641:
		// the ProxyWorker's error reports arrive as JSON-serialized plain objects,
		// and used to be re-wrapped in a message-less Error, so the resulting
		// fatal log was an empty `✘ [ERROR]` with no clue about the failure.
		const bus = new FakeBus();
		const controller = new ProxyController(bus);
		const waited = bus.waitFor("error");

		const original = new Error("Network connection lost.");
		const serialized = JSON.parse(
			JSON.stringify(serialiseError(original))
		) as SerializedError;
		controller.onProxyWorkerMessage({ type: "error", error: serialized });

		const event = await waited;
		expect(event.source).toBe("ProxyController");
		expect(event.reason).toBe("Error inside ProxyWorker");
		expect(event.cause).toBeInstanceOf(Error);
		expect(event.cause.message).toBe("Network connection lost.");
		expect(event.cause.stack).toBe(original.stack);
	});

	test("Runtime.exceptionThrown dispatches a typed runtimeError event", async ({
		expect,
	}) => {
		const bus = new FakeBus();
		const controller = new ProxyController(bus);
		const waited = bus.waitFor("runtimeError");
		controller.onInspectorProxyWorkerMessage({
			method: "Runtime.exceptionThrown",
			params: {
				timestamp: 0,
				exceptionDetails: {
					exceptionId: 1,
					text: "Uncaught Error: boom",
					lineNumber: 0,
					columnNumber: 0,
					exception: {
						type: "object",
						subtype: "error",
						description: "Error: boom\n    at fetch (index.js:1:1)",
					},
				},
			},
		});
		const event = await waited;
		expect(event.source).toBe("ProxyController");
		expect(event.text).toBe("Uncaught Error: boom");
		expect(event.stack).toContain("Error: boom");
		expect(event.exceptionDetails?.exceptionId).toBe(1);
	});

	test("recovers with an ephemeral inspector port when an auto-selected inspector port is in use", async ({
		expect,
		onTestFinished,
	}) => {
		const server = net.createServer();
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		onTestFinished(
			() => new Promise<void>((resolve) => server.close(() => resolve()))
		);
		const occupiedPort = (server.address() as AddressInfo).port;

		const bus = new FakeBus();
		const controller = new ProxyController(bus);
		teardown(() => controller.teardown());

		controller.onConfigUpdate({
			type: "configUpdate",
			config: makeProxyConfig(occupiedPort),
			inspectorPortAutoSelected: true,
		});

		const readyEvent = await controller.ready.promise;
		expect(readyEvent.inspectorUrl).toBeDefined();
		expect(Number(readyEvent.inspectorUrl?.port)).not.toBe(occupiedPort);
		expect(bus.events.filter((event) => event.type === "error")).toHaveLength(
			0
		);
	});

	test("reports ERR_ADDRESS_IN_USE when an explicit inspector port is already in use", async ({
		expect,
		onTestFinished,
	}) => {
		const server = net.createServer();
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		onTestFinished(
			() => new Promise<void>((resolve) => server.close(() => resolve()))
		);
		const occupiedPort = (server.address() as AddressInfo).port;

		const bus = new FakeBus();
		const controller = new ProxyController(bus);
		teardown(() => controller.teardown().catch(() => {}));

		const errorPromise = bus.waitFor("error");
		controller.onConfigUpdate({
			type: "configUpdate",
			config: makeProxyConfig(occupiedPort),
			inspectorPortAutoSelected: false,
		});

		const errorEvent = await errorPromise;
		expect(errorEvent.source).toBe("ProxyController");
		expect(errorEvent.cause).toMatchObject({
			code: "ERR_ADDRESS_IN_USE",
			message: `Address already in use (127.0.0.1:${occupiedPort}). Please check that you are not already running a server on this address.`,
		});
	});
});
