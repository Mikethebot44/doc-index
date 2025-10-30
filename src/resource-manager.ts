import { Resource } from './types';
import { normalizeNamespace } from './pinecone';

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

export async function getResources(index: any, namespace?: string): Promise<Resource[]> {
  const normalizedNamespace = normalizeNamespace(namespace);
  try {
    const namespaced = typeof index.namespace === 'function'
      ? index.namespace(normalizedNamespace)
      : undefined;
    const fetchTarget = namespaced && typeof namespaced.fetch === 'function' ? namespaced : index;
    const fetchPayload: Record<string, unknown> = { ids: [RESOURCES_METADATA_KEY] };
    if (fetchTarget === index) {
      fetchPayload.namespace = normalizedNamespace;
    }

    try {
      const fetchResponse = await fetchTarget.fetch(fetchPayload);
      const fetched = fetchResponse?.vectors?.[RESOURCES_METADATA_KEY]?.metadata?.resources;
      const resources = normalizeResources(fetched);
      if (resources.length > 0) {
        return resources;
      }
    } catch (fetchError) {
      if (fetchTarget === index) {
        try {
          const fallbackResponse = await fetchTarget.fetch({ ids: [RESOURCES_METADATA_KEY] }, normalizedNamespace);
          const fetched = fallbackResponse?.vectors?.[RESOURCES_METADATA_KEY]?.metadata?.resources;
          const resources = normalizeResources(fetched);
          if (resources.length > 0) {
            return resources;
          }
        } catch {
          // swallow to allow query fallback below
        }
      } else {
        throw fetchError;
      }
    }
  } catch (error) {
    // Ignore fetch errors; we'll attempt query as a fallback.
  }

  try {
    const namespaced = typeof index.namespace === 'function'
      ? index.namespace(normalizedNamespace)
      : undefined;
    const queryTarget = namespaced && typeof namespaced.query === 'function' ? namespaced : index;
    const queryPayload: Record<string, unknown> = {
      id: RESOURCES_METADATA_KEY,
      topK: 1,
      includeMetadata: true,
    };
    if (queryTarget === index) {
      queryPayload.namespace = normalizedNamespace;
    }

    let queryResponse;
    try {
      queryResponse = await queryTarget.query(queryPayload);
    } catch (queryError) {
      if (queryTarget === index) {
        try {
          queryResponse = await queryTarget.query({
            id: RESOURCES_METADATA_KEY,
            topK: 1,
            includeMetadata: true,
          }, normalizedNamespace);
        } catch {
          throw queryError;
        }
      } else {
        throw queryError;
      }
    }

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
  resources: Resource[],
  namespace?: string
): Promise<void> {
  try {
    const normalizedNamespace = normalizeNamespace(namespace);
    const namespaced = typeof index.namespace === 'function'
      ? index.namespace(normalizedNamespace)
      : undefined;
    const values = Array(3072)
      .fill(0)
      .map(() => 0.001);
    const payload = {
      id: RESOURCES_METADATA_KEY,
      values,
      metadata: {
        resources: JSON.stringify(resources),
      },
    };

    if (namespaced && typeof namespaced.upsert === 'function') {
      await namespaced.upsert([payload]);
      return;
    }

    if (typeof index.upsert !== 'function') {
      throw new Error('Pinecone index does not support upsert operations');
    }

    try {
      await index.upsert({
        namespace: normalizedNamespace,
        vectors: [payload],
      });
    } catch (error) {
      await index.upsert([payload], normalizedNamespace);
    }
  } catch (error) {
    console.error('Failed to save resources:', error);
  }
}

export async function addResource(
  index: any,
  resource: Resource,
  namespace?: string
): Promise<void> {
  const resources = await getResources(index, namespace);
  const existingIndex = resources.findIndex(r => r.id === resource.id);

  if (existingIndex >= 0) {
    resources[existingIndex] = resource;
  } else {
    resources.push(resource);
  }

  await saveResources(index, resources, namespace);
}

export async function updateResource(
  index: any,
  resourceId: string,
  updates: Partial<Resource>,
  namespace?: string
): Promise<void> {
  const resources = await getResources(index, namespace);
  const resource = resources.find(r => r.id === resourceId);

  if (resource) {
    Object.assign(resource, updates);
    resource.updatedAt = Date.now();
    await saveResources(index, resources, namespace);
  }
}

export async function getResource(
  index: any,
  resourceId: string,
  namespace?: string
): Promise<Resource | undefined> {
  const resources = await getResources(index, namespace);
  return resources.find(r => r.id === resourceId);
}

export async function deleteResource(
  index: any,
  resourceId: string,
  namespace?: string
): Promise<void> {
  const resources = await getResources(index, namespace);
  const filtered = resources.filter(r => r.id !== resourceId);
  await saveResources(index, filtered, namespace);
}

export async function deleteResourceFromPinecone(
  index: any,
  resourceId: string,
  namespace?: string
): Promise<void> {
  try {
    const normalizedNamespace = normalizeNamespace(namespace);
    const namespaced = typeof index.namespace === 'function'
      ? index.namespace(normalizedNamespace)
      : undefined;

    if (namespaced && typeof namespaced.deleteMany === 'function') {
      await namespaced.deleteMany({
        resourceId: { $eq: resourceId },
      });
      return;
    }

    if (typeof index.deleteMany !== 'function') {
      throw new Error('Pinecone index does not support deleteMany operations');
    }

    try {
      await index.deleteMany({
        namespace: normalizedNamespace,
        filter: {
          resourceId: { $eq: resourceId },
        },
      });
    } catch (error) {
      await index.deleteMany({
        resourceId: { $eq: resourceId },
      }, normalizedNamespace);
    }
  } catch (error) {
    console.error('Failed to delete vectors from Pinecone:', error);
  }
}

