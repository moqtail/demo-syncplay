import type { FragmentRange } from './types';

// Import directly from the TypeScript library paths
import { Fetch } from '../../../libs/moqtail-ts/src/model/control/fetch';
import { FetchType, GroupOrder } from '../../../libs/moqtail-ts/src/model/control/constant';
import { FullTrackName } from '../../../libs/moqtail-ts/src/model/data/full_track_name';
import { Location } from '../../../libs/moqtail-ts/src/model/common/location';
import { FetchObject } from '../../../libs/moqtail-ts/src/model/data/fetch_object';
import { FrozenByteBuffer } from '../../../libs/moqtail-ts/src/model/common/byte_buffer';

export const requestFragmentRange = async (range: FragmentRange): Promise<Blob> => {
  const { startGroupId, startObjectId, endGroupId, endObjectId } = range;

  // Validate range
  if (
    startGroupId > endGroupId ||
    (startGroupId === endGroupId && startObjectId > endObjectId)
  ) {
    throw new Error('Start range cannot be greater than end range');
  }

  const url = new URL('http://localhost:8001/range');
  url.searchParams.append('StartGroupId', startGroupId.toString());
  url.searchParams.append('StartObjectId', startObjectId.toString());
  url.searchParams.append('EndGroupId', endGroupId.toString());
  url.searchParams.append('EndObjectId', endObjectId.toString());

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.blob();
};

// Create a Fetch request using the proper moqtail-ts library
const createFetchRequest = (range: FragmentRange): Uint8Array => {
  const { startGroupId, startObjectId, endGroupId, endObjectId } = range;
  
  // Create FullTrackName
  const fullTrackName = FullTrackName.tryNew('demo/video', 'track1');
  
  // Create locations  
  const startLocation = new Location(BigInt(startGroupId), BigInt(startObjectId));
  const endLocation = new Location(BigInt(endGroupId), BigInt(endObjectId));
  
  // Create the Fetch request with StandAlone type
  const fetchRequest = new Fetch(
    123n, // request ID
    128, // subscriber priority  
    GroupOrder.Ascending,
    {
      type: FetchType.StandAlone,
      props: { fullTrackName, startLocation, endLocation }
    },
    [] // no parameters
  );

  // Serialize the fetch request
  const serialized = fetchRequest.serialize();
  return serialized.toUint8Array();
};

export const requestFragmentRangeWithFetch = async (range: FragmentRange): Promise<Blob> => {
  const { startGroupId, startObjectId, endGroupId, endObjectId } = range;

  // Validate range
  if (
    startGroupId > endGroupId ||
    (startGroupId === endGroupId && startObjectId > endObjectId)
  ) {
    throw new Error('Start range cannot be greater than end range');
  }

  // Create and serialize the fetch request
  const serializedFetch = createFetchRequest(range);

  // Send the serialized fetch request
  const response = await fetch('http://localhost:8001/fetch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(serializedFetch).buffer.slice(0, serializedFetch.length),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  // Get the response as bytes
  const responseBytes = await response.arrayBuffer();
  const responseUint8Array = new Uint8Array(responseBytes);
  
  // Parse FetchObjects using the proper moqtail-ts library
  const videoChunks: Uint8Array[] = [];
  let offset = 0;

  while (offset < responseUint8Array.length) {
    // Read the length prefix (4 bytes)
    if (offset + 4 > responseUint8Array.length) break;
    
    const lengthBytes = responseUint8Array.slice(offset, offset + 4);
    const length = new DataView(lengthBytes.buffer).getUint32(0);
    offset += 4;

    // Read the FetchObject data
    if (offset + length > responseUint8Array.length) break;
    
    const fetchObjectBytes = responseUint8Array.slice(offset, offset + length);
    
    try {
      // Create a FrozenByteBuffer from the bytes and deserialize properly
      const buffer = new FrozenByteBuffer(fetchObjectBytes);
      const fetchObject = FetchObject.deserialize(buffer);

      // Extract the payload if it exists
      if (fetchObject.payload) {
        videoChunks.push(fetchObject.payload);
        console.log(`Extracted payload: group=${fetchObject.groupId}, object=${fetchObject.objectId}, size=${fetchObject.payload.length}`);
      }
    } catch (error) {
      console.warn('Failed to parse FetchObject:', error);
      // If parsing fails, skip this object 
    }
    
    offset += length;
  }

  // If we couldn't extract proper payloads, fall back to using the raw response
  if (videoChunks.length === 0) {
    console.warn('No payloads extracted, using raw response data');
    return new Blob([responseBytes], { type: 'video/mp4' });
  }

  // Combine all video chunks into a single blob
  const totalLength = videoChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combinedData = new Uint8Array(totalLength);
  let combinedOffset = 0;
  
  for (const chunk of videoChunks) {
    combinedData.set(chunk, combinedOffset);
    combinedOffset += chunk.length;
  }

  return new Blob([combinedData], { type: 'video/mp4' });
};