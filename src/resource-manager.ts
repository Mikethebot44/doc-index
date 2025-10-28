import { Resource } from './types';

const RESOURCES_METADATA_KEY = '__resources__';

function normalizeResources(raw: unknown): Resource[] {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw as Resource[];
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Resource[]) : [];
    } catch {
      return [];
    }
  }

  if (typeof raw === 'object' && Array.isArray((raw as any).resources)) {
    return (raw as any).resources as Resource[];
  }

  return [];
}

export async function getResources(index: any): Promise<Resource[]> {
  try {
    const fetchResponse = await index.fetch({
      ids: [RESOURCES_METADATA_KEY],
    });
    const fetched = fetchResponse?.vectors?.[RESOURCES_METADATA_KEY]?.metadata?.resources;
    const resources = normalizeResources(fetched);
    if (resources.length > 0) {
      return resources;
    }
  } catch (error) {
    // Ignore fetch errors; we'll attempt query as a fallback.
  }

  try {
    const queryResponse = await index.query({
      id: RESOURCES_METADATA_KEY,
      topK: 1,
      includeMetadata: true,
    });

    if (Array.isArray(queryResponse?.matches) && queryResponse.matches.length > 0) {
      const metadata = queryResponse.matches[0]?.metadata;
      const raw = metadata?.resources ?? (metadata as any)?.resourcesJson;
      return normalizeResources(raw);
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
    const values = Array(3072)
      .fill(0)
      .map(() => 0.001);
    await index.upsert([{
      id: RESOURCES_METADATA_KEY,
      values,
      metadata: {
        resources: JSON.stringify(resources),
      },
    }]);
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

