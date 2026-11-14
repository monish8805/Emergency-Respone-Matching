import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  REQUEST_NEXT,
  RESOURCE_STATUSES,
  RESOURCE_TYPES,
  createRequest,
  getSystem,
  listRequests,
  listResources,
  registerResource,
  setRequestStatus,
  setResourceStatus,
  triggerMatch,
  type RequestStatus,
  type Resource,
  type ResourceStatus,
  type ResourceType,
  type SystemStatus,
} from "../api";

export const Route = createFileRoute("/")({ component: Home });

const POLL_MS = 3000;

// A resource id starts with its type ("water-9f3a…"), so the part worth showing is the unique tail.
const shortId = (id: string) => id.slice(id.indexOf("-") + 1, id.indexOf("-") + 9);

// While nothing has loaded yet, TanStack Query clears a query's error every time it starts the next
// poll, so a plain `query.error` flashes on for a moment and off again. This keeps the last error
// on screen until a load actually succeeds.
function useStickyError(query: { error: Error | null; isSuccess: boolean; dataUpdatedAt: number }) {
  const [sticky, setSticky] = useState<Error | null>(null);
  useEffect(() => {
    if (query.error) setSticky(query.error);
    else if (query.isSuccess) setSticky(null);
  }, [query.error, query.isSuccess, query.dataUpdatedAt]);
  return sticky;
}

function Home() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  // No automatic retries: the poll already retries every few seconds, and retries would only keep
  // the page on "Loading…" for longer when the backend is down.
  const requests = useQuery({ queryKey: ["requests"], queryFn: () => listRequests(), refetchInterval: POLL_MS, retry: false });
  const resources = useQuery({ queryKey: ["resources"], queryFn: () => listResources(), refetchInterval: POLL_MS, retry: false });
  const requestsError = useStickyError(requests);
  const resourcesError = useStickyError(resources);
  const system = useQuery({ queryKey: ["system"], queryFn: () => getSystem(), refetchInterval: POLL_MS, retry: false });

  // Every mutation refreshes both lists, since matching changes both.
  const options = <T,>(message?: string | ((result: T) => string | null)) => ({
    onSuccess: (result: T) => {
      setNotice(typeof message === "function" ? message(result) : (message ?? null));
      return queryClient.invalidateQueries();
    },
    onError: () => setNotice(null),
  });

  const submitRequest = useMutation({ mutationFn: createRequest, ...options("Request submitted") });
  const submitResource = useMutation({ mutationFn: registerResource, ...options("Resource registered") });
  const updateRequest = useMutation({ mutationFn: setRequestStatus, ...options() });
  const updateResource = useMutation({
    mutationFn: setResourceStatus,
    ...options<Resource>((r) =>
      r.releasedRequestId ? "That resource was serving a request, which went back to PENDING to be matched again." : null,
    ),
  });
  const match = useMutation({ mutationFn: triggerMatch, ...options("Match queued") });

  // The health panel reports its own failures, so they do not also show up as a banner.
  const actionError = [submitRequest, submitResource, updateRequest, updateResource, match].map((q) => q.error).find(Boolean);
  const loadError = requestsError ?? resourcesError;
  const error = actionError ?? (loadError ? new Error(`Cannot load data: ${loadError.message}`) : null);

  const requestList = requests.data ?? [];
  const resourceList = resources.data ?? [];

  const requestLabel = (id: string | null | undefined) => {
    if (!id) return "—";
    const r = requestList.find((x) => x.id === id);
    return r ? `${r.type} @ ${r.location}` : id.slice(0, 8);
  };

  const resourceLabel = (id: string | null) => {
    if (!id) return "—";
    const r = resourceList.find((x) => x.id === id);
    return r ? `${r.type} @ ${r.location} (${shortId(id)})` : shortId(id);
  };

  return (
    <main>
      <h1>Emergency Response Matching</h1>
      <HealthPanel status={system.data} error={system.error?.message} loading={system.isPending} />
      {error && <div className="banner error">{error.message}</div>}
      {notice && !error && <div className="banner ok">{notice}</div>}

      <div className="grid">
        <RequestForm onSubmit={(d) => submitRequest.mutateAsync({ data: d })} />
        <ResourceForm onSubmit={(d) => submitResource.mutateAsync({ data: d })} />
      </div>

      <section>
        <h2>Requests{requests.data ? ` (${requestList.length})` : ""}</h2>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Location</th>
              <th>Details</th>
              <th>Status</th>
              <th>Assigned resource</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {requestList.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  {requestsError
                    ? `Could not load requests: ${requestsError.message}. Retrying every ${POLL_MS / 1000} seconds…`
                    : requests.isPending
                      ? "Loading…"
                      : "No requests yet."}
                </td>
              </tr>
            )}
            {requestList.map((r) => (
              <tr key={r.id}>
                <td>{r.type}</td>
                <td>{r.location}</td>
                <td>{r.details || "—"}</td>
                <td>
                  <StatusSelect
                    value={r.status}
                    options={[r.status, ...REQUEST_NEXT[r.status]]}
                    disabled={REQUEST_NEXT[r.status].length === 0}
                    onChange={(s) => updateRequest.mutate({ data: { id: r.id, status: s as RequestStatus } })}
                  />
                </td>
                <td>
                  {resourceLabel(r.resourceId)}
                  {r.resourceId && r.distanceKm != null && <small className="muted"> · {r.distanceKm} km away</small>}
                </td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  {r.status === "PENDING" && (
                    <button onClick={() => match.mutate({ data: { id: r.id } })}>Match</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Resources{resources.data ? ` (${resourceList.length})` : ""}</h2>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Location</th>
              <th>Status</th>
              <th>Serving request</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {resourceList.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {resourcesError
                    ? `Could not load resources: ${resourcesError.message}. Retrying every ${POLL_MS / 1000} seconds…`
                    : resources.isPending
                      ? "Loading…"
                      : "No resources registered."}
                </td>
              </tr>
            )}
            {resourceList.map((r) => (
              <tr key={r.id}>
                <td>{r.type}</td>
                <td>{r.location}</td>
                <td>
                  <StatusSelect
                    value={r.status}
                    options={RESOURCE_STATUSES}
                    onChange={(s) => updateResource.mutate({ data: { id: r.id, status: s as ResourceStatus } })}
                  />
                </td>
                <td>{requestLabel(r.assignedRequestId)}</td>
                <td className="mono">{shortId(r.id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function HealthPanel({
  status,
  error,
  loading,
}: {
  status?: SystemStatus;
  error?: string;
  loading: boolean;
}) {
  if (loading) return <div className="health muted">Checking services…</div>;
  if (error || !status) {
    return (
      <div className="health">
        <Chip label="Request service" state="down" detail={error ?? "unreachable"} />
      </div>
    );
  }
  const nodes = status.coordinator.nodes ?? [];
  return (
    <div className="health">
      <Chip label="Request service" state={status.requestService === "up" ? "up" : "down"} />
      <Chip label="RabbitMQ" state={status.rabbitmq === "up" ? "up" : status.rabbitmq === "down" ? "down" : "unknown"} />
      <Chip
        label="Coordinator"
        state={status.coordinator.reachable ? "up" : "down"}
        detail={status.coordinator.reachable ? undefined : status.coordinator.error}
      />
      {(status.coordinator.shards ?? []).map((sh) => (
        <Chip
          key={sh.shard}
          label={`Shard ${sh.shard}`}
          state={sh.live === sh.total ? "up" : sh.live > 0 ? "degraded" : "down"}
          detail={`${sh.live}/${sh.total} nodes${nodes
            .filter((n) => n.shard === sh.shard && n.status !== "up")
            .map((n) => ` · ${n.id} ${n.status}`)
            .join("")}`}
        />
      ))}
    </div>
  );
}

function Chip({ label, state, detail }: { label: string; state: "up" | "down" | "degraded" | "unknown"; detail?: string }) {
  return (
    <span className={`chip ${state}`} title={detail}>
      <span className="dot" />
      {label}
      {detail && <small>{detail}</small>}
    </span>
  );
}

function StatusSelect({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select className={`status ${value}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function RequestForm({
  onSubmit,
}: {
  onSubmit: (d: { type: ResourceType; location: string; details: string }) => Promise<unknown>;
}) {
  const [type, setType] = useState<ResourceType>("water");
  const [location, setLocation] = useState("");
  const [details, setDetails] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSubmit({ type, location, details });
      setLocation("");
      setDetails("");
    } catch {
      // the error banner shows the message
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Emergency request</h2>
      <label>
        Type
        <TypeSelect value={type} onChange={setType} />
      </label>
      <label>
        Location
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Zone A  or  12.97, 77.59" required />
        <small className="hint">A zone name, or latitude, longitude. Coordinates match resources within a few km.</small>
      </label>
      <label>
        Details
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="Need drinking water for 20 people"
          rows={3}
        />
      </label>
      <button type="submit">Submit request</button>
    </form>
  );
}

function ResourceForm({
  onSubmit,
}: {
  onSubmit: (d: { type: ResourceType; location: string; availability: boolean }) => Promise<unknown>;
}) {
  const [type, setType] = useState<ResourceType>("water");
  const [location, setLocation] = useState("");
  const [availability, setAvailability] = useState(true);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSubmit({ type, location, availability });
      setLocation("");
    } catch {
      // the error banner shows the message
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Register resource / volunteer</h2>
      <label>
        Type
        <TypeSelect value={type} onChange={setType} />
      </label>
      <label>
        Location
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Zone A  or  12.97, 77.59" required />
        <small className="hint">A zone name, or latitude, longitude. A zone name only matches the same zone.</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={availability} onChange={(e) => setAvailability(e.target.checked)} />
        Available now
      </label>
      <button type="submit">Register resource</button>
    </form>
  );
}

function TypeSelect({ value, onChange }: { value: ResourceType; onChange: (v: ResourceType) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as ResourceType)}>
      {RESOURCE_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}
