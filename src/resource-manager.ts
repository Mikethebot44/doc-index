import { Resource } from './types';

const RESOURCES_METADATA_KEY = '__resources__';

export async function getResources(index: any): Promise<Resource[]> {
  try {
    const queryResponse = await index.query({
      id: RESOURCES_METADATA_KEY,
      topK: 1,
    });
    
    if (queryResponse.matches && queryResponse.matches.length > 0) {
      const metadata = queryResponse.matches[0].metadata;
      return (metadata?.resources as Resource[]) || [];
    }
    
    return [];
  } catch (error) {
    return [];
  }
}

export async function saveResources(
  index: any,
  resources: Resource[]
): Promise<void> {
  try {
    await index.upsert({
      id: RESOURCES_METADATA_KEY,
      values: Array(3072).fill(0),
      metadata: {
        resources: JSON.stringify(resources),
      },
    });
  } catch (error) {
    console.error('Failed to save resources:', error);
  }
}

export async function addResource(
  index: any,
  resource: Resource
): Promise<void> {
  const resources = await getResources(index);
  const existingIndex = resources.findIndex(r => r.id === resource.id);
  
  if (existingIndex >= 0) {
    resources[existingIndex] = resource;
  } else {
    resources.push(resource);
  }
  
  await saveResources(index, resources);
}

export async function updateResource(
  index: any,
  resourceId: string,
  updates: Partial<Resource>
): Promise<void> {
  const resources = await getResources(index);
  const resource = resources.find(r => r.id === resourceId);
  
  if (resource) {
    Object.assign(resource, updates);
    resource.updatedAt = Date.now();
    await saveResources(index, resources);
  }
}

export async function getResource(
  index: any,
  resourceId: string
): Promise<Resource | undefined> {
  const resources = await getResources(index);
  return resources.find(r => r.id === resourceId);
}

export async function deleteResource(
  index: any,
  resourceId: string
): Promise<void> {
  const resources = await getResources(index);
  const filtered = resources.filter(r => r.id !== resourceId);
  await saveResources(index, filtered);
}

export async function deleteResourceFromPinecone(
  index: any,
  resourceId: string
): Promise<void> {
  try {
    await index.deleteMany({
      resourceId: { $eq: resourceId },
    });
  } catch (error) {
    console.error('Failed to delete vectors from Pinecone:', error);
  }
}

