/**
 * Copyright 2025 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { FragmentRange } from './types';

import {
  MOQtailClient,
  FetchType,
  GroupOrder,
  FullTrackName,
  Location,
  FetchError,
  Tuple,
  FilterType,
  SubscribeError,
} from 'moqtail-ts';

const MOQ_RELAY_URL = window.appSettings.relayUrl;
const SUPPORTED_VERSIONS = [0xFF00000E]; //constants -> draft 14

let moqClient: MOQtailClient | null = null;

async function getMOQClient(): Promise<MOQtailClient> {
  if (!moqClient) {
    // Check WebTransport support before attempting connection
    if (typeof WebTransport === 'undefined') {
      throw new Error('WebTransport is not supported in this browser. Please enable WebTransport in chrome://flags/#webtransport-developer-mode');
    }

    //console.log('[moq-api] Connecting to MOQ relay at', MOQ_RELAY_URL);

    try {
      moqClient = await MOQtailClient.new({
        url: MOQ_RELAY_URL,
        supportedVersions: SUPPORTED_VERSIONS,
        dataStreamTimeoutMs: 10000,
        controlStreamTimeoutMs: 5000,
        callbacks: {
          //onMessageSent: (msg: ControlMessage) => console.log('[moq-api] MOQ sent:', msg.constructor.name),
          //onMessageReceived: (msg: ControlMessage) => console.log('[moq-api] MOQ received:', msg.constructor.name),
          onSessionTerminated: (reason?: unknown) => console.warn('[moq-api] MOQ session terminated:', reason)
        }
      });

      //console.log('[moq-api] Connected to MOQ relay successfully');
    } catch (error) {
      console.error('[moq-api] Failed to connect to MOQ relay:', error);
      throw new Error(`MOQ connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return moqClient;
}

export async function fetchRangeStreamingWithMOQ(
  startGroupId: number,
  startObjectId: number,
  endGroupId: number,
  endObjectId: number,
  onChunk: (payload: Uint8Array, loc: { group: number; object: number }) => void,
): Promise<void> {
  const client = await getMOQClient();

  const namespace = Tuple.fromUtf8Path("moqtail");
  const fullTrackName = FullTrackName.tryNew(namespace, "demo");
  const startLocation = new Location(
    BigInt(startGroupId),
    BigInt(startObjectId),
  );
  const endLocation = new Location(
    BigInt(endGroupId),
    BigInt(endObjectId),
  );

  const res = await client.fetch({
    priority: 1,
    groupOrder: GroupOrder.Original,
    typeAndProps: {
      type: FetchType.StandAlone,
      props: {
        fullTrackName: fullTrackName,
        startLocation,
        endLocation,
      },
    },
  });

  if (res instanceof FetchError) {
    throw new Error(
      `MOQ fetch failed: ${res.errorCode} - ${res.reasonPhrase.phrase}`,
    );
  }

  const reader = res.stream.getReader();

  try {
    while (true) {
      const { done, value: moqtObject } = await reader.read();
      if (done) break;
      if (moqtObject && moqtObject.payload) {
        onChunk(
          new Uint8Array(moqtObject.payload),
          {
            group: Number(moqtObject.location.group),
            object: Number(moqtObject.location.object),
          }
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchRangeBytesWithMOQ(
  fullTrackName: FullTrackName,
  startLocation: Location,
  endLocation: Location,
): Promise<Uint8Array> {
  const client = await getMOQClient();

  console.log(
    `[moq-api] Sending MOQ fetch request: ${startLocation.group}:${startLocation.object} -> ${endLocation.group}:${endLocation.object}`,
  );

  const res = await client.fetch({
    priority: 1,
    groupOrder: GroupOrder.Original,
    typeAndProps: {
      type: FetchType.StandAlone,
      props: {
        fullTrackName,
        startLocation,
        endLocation,
      },
    },
  });

  if (res instanceof FetchError) {
    throw new Error(
      `MOQ fetch failed: ${res.errorCode} - ${res.reasonPhrase.phrase}`,
    );
  }

  //console.log('[moq-api] MOQ fetch started, reading stream...');
  const reader = res.stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value: moqtObject } = await reader.read();
      if (done) {
        //console.log('[moq-api] MOQ fetch stream completed');
        break;
      }
      if (moqtObject && moqtObject.payload) {
        // console.warn(
        //   `[moq-api] Received MOQ object: group=${moqtObject.location.group}, object=${moqtObject.location.object}`
        // );
        chunks.push(new Uint8Array(moqtObject.payload));
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    throw new Error("No data received from MOQ fetch");
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.length;
  }

  console.warn(
    `[moq-api] MOQ fetch completed: ${chunks.length} objects, ${totalLength} bytes total`
  );

  return combined;
}

export const requestInitWithMOQ = async (): Promise<Uint8Array> => {
  try {
    const namespace = Tuple.fromUtf8Path("moqtail");
    const fullTrackName = FullTrackName.tryNew(namespace, "demo");

    const initStart = new Location(0n, 0n);
    const initEnd = new Location(0n, 0n);

    //console.log('[moq-api] Requesting MOQ init segment (0:0 -> 0:0)');
    return await fetchRangeBytesWithMOQ(fullTrackName, initStart, initEnd);
  } catch (error) {
    //console.error('[moq-api] MOQ init fetch error:', error);
    if (
      error instanceof Error &&
      (error.message.includes("connection") ||
        error.message.includes("transport") ||
        error.message.includes("WebTransport"))
    ) {
      moqClient = null;
    }
    throw error;
  }
};

export const requestFragmentRangeBodyWithMOQ = async (
  range: FragmentRange,
): Promise<Uint8Array> => {
  const { startGroupId, startObjectId, endGroupId, endObjectId } = range;

  if (
    startGroupId > endGroupId ||
    (startGroupId === endGroupId && startObjectId > endObjectId)
  ) {
    throw new Error("Start range cannot be greater than end range");
  }

  console.warn('[moq-api] Requesting MOQ fragment body for range:', range);

  try {
    const namespace = Tuple.fromUtf8Path("moqtail");
    const fullTrackName = FullTrackName.tryNew(namespace, "demo");

    const startLocation = new Location(
      BigInt(startGroupId),
      BigInt(startObjectId),
    );
    const endLocation = new Location(BigInt(endGroupId), BigInt(endObjectId));

    return await fetchRangeBytesWithMOQ(
      fullTrackName,
      startLocation,
      endLocation,
    );
  } catch (error) {
    console.error('[moq-api] MOQ fragment body fetch error:', error);
    if (
      error instanceof Error &&
      (error.message.includes("connection") ||
        error.message.includes("transport") ||
        error.message.includes("WebTransport"))
    ) {
      moqClient = null;
    }
    throw error;
  }
};

export const subscribeToDemo = async (): Promise<void> => {
  const client = await getMOQClient();
  try {
    const namespace = Tuple.fromUtf8Path("moqtail");
    const fullTrackName = FullTrackName.tryNew(namespace, "demo");
    //console.log('[moq-api] Subscribing to', fullTrackName.toString());

    const res = await client.subscribe({
      fullTrackName,
      priority: 1,
      groupOrder: GroupOrder.Original,
      forward: false,
      filterType: FilterType.LatestObject,
    });

    if (res instanceof SubscribeError) {
      //console.error('[moq-api] Subscribe refused:', res);
      alert('Subscribe refused: ' + JSON.stringify(res));
      return;
    }

    //console.log('[moq-api] Subscribe successful, reading stream...');
    const reader = res.stream.getReader();

    (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) {
            //console.log('[moq-api] Subscription stream completed');
            break;
          }
          //console.log('[moq-api] Received subscribed object:', value);
        }
      } catch (err) {
        console.error('[moq-api] Error reading subscription stream:', err);
      } finally {
        reader.releaseLock();
      }
    })();
  } catch (e) {
    console.error('[moq-api] Subscribe failed:', e);
    throw e;
  }
}

export const disconnectMOQ = async (): Promise<void> => {
  if (moqClient) {
    //console.log('[moq-api] Disconnecting MOQ client');
    await moqClient.disconnect();
    moqClient = null;
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    disconnectMOQ().catch((e) => console.error('[moq-api] error in disconnectMOQ', e));
  });
}