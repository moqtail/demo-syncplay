import type { FragmentRange } from './types';

import { 
  MOQtailClient,
  FetchType, 
  GroupOrder,
  FullTrackName,
  Location,
  FetchError,
  Tuple,
  type ControlMessage
} from '../../../libs/moqtail-ts/src/index';

const MOQ_RELAY_URL = 'https://localhost:4433/transport'; 
const SUPPORTED_VERSIONS = [0xFF00000E]; //constants -> draft 14

let moqClient: MOQtailClient | null = null;

async function getMOQClient(): Promise<MOQtailClient> {
  if (!moqClient) {
    console.log('Connecting to MOQ relay at', MOQ_RELAY_URL);
    
    try {
      moqClient = await MOQtailClient.new({
        url: MOQ_RELAY_URL,
        supportedVersions: SUPPORTED_VERSIONS,
        dataStreamTimeoutMs: 10000,
        controlStreamTimeoutMs: 5000,
        callbacks: {
          onMessageSent: (msg: ControlMessage) => console.log('MOQ sent:', msg.constructor.name),
          onMessageReceived: (msg: ControlMessage) => console.log('MOQ received:', msg.constructor.name),
          onSessionTerminated: (reason?: unknown) => console.warn('MOQ session terminated:', reason)
        }
      });
      
      console.log('Connected to MOQ relay successfully');
    } catch (error) {
      console.error('Failed to connect to MOQ relay:', error);
      throw new Error(`MOQ connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  return moqClient;
}

export const requestFragmentRangeWithMOQ = async (range: FragmentRange): Promise<Blob> => {
  const { startGroupId, startObjectId, endGroupId, endObjectId } = range;

  if (
    startGroupId > endGroupId ||
    (startGroupId === endGroupId && startObjectId > endObjectId)
  ) {
    throw new Error('Start range cannot be greater than end range');
  }

  console.log('Requesting MOQ fetch for range:', range);

  try {
    const client = await getMOQClient();

    const namespace = Tuple.fromUtf8Path("moqtail");
    const fullTrackName = FullTrackName.tryNew(namespace, "demo");
    
    const startLocation = new Location(BigInt(startGroupId), BigInt(startObjectId));
    const endLocation = new Location(BigInt(endGroupId), BigInt(endObjectId));
    
    console.log('Sending MOQ fetch request:', {
      startLocation: `${startGroupId}:${startObjectId}`,
      endLocation: `${endGroupId}:${endObjectId}`,
      trackName: fullTrackName.toString()
    });

    const fetchResult = await client.fetch({
      priority: 1, 
      groupOrder: GroupOrder.Original,
      typeAndProps: {
        type: FetchType.StandAlone,
        props: {
          fullTrackName,
          startLocation,
          endLocation
        }
      }
    });

    if (fetchResult instanceof FetchError) {
      throw new Error(`MOQ fetch failed: ${fetchResult.errorCode} - ${fetchResult.reasonPhrase.phrase}`);
    }

    console.log('MOQ fetch started, reading stream...');
    const videoChunks: Uint8Array[] = [];
    const reader = fetchResult.stream.getReader();
    
    try {
      while (true) {
        const { done, value: moqtObject } = await reader.read();
        
        if (done) {
          console.log('MOQ fetch stream completed');
          break;
        }

        if (moqtObject && moqtObject.payload) {
          console.log(`Received MOQ object: group=${moqtObject.location.group}, object=${moqtObject.location.object}, size=${moqtObject.payload.length}`);
          videoChunks.push(new Uint8Array(moqtObject.payload));
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (videoChunks.length === 0) {
      throw new Error('No data received from MOQ fetch');
    }

    const totalLength = videoChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combinedData = new Uint8Array(totalLength);
    let combinedOffset = 0;
    
    for (const chunk of videoChunks) {
      combinedData.set(chunk, combinedOffset);
      combinedOffset += chunk.length;
    }

    console.log(`MOQ fetch completed: ${videoChunks.length} objects, ${totalLength} bytes total`);
    
    return new Blob([combinedData], { type: 'video/mp4' });

  } catch (error) {
    console.error('MOQ fetch error:', error);
    
    if (error instanceof Error && (
      error.message.includes('connection') || 
      error.message.includes('transport') ||
      error.message.includes('WebTransport')
    )) {
      moqClient = null;
    }
    
    throw error;
  }
};

export const disconnectMOQ = async (): Promise<void> => {
  if (moqClient) {
    console.log('Disconnecting MOQ client');
    await moqClient.disconnect();
    moqClient = null;
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    disconnectMOQ().catch(console.error);
  });
}