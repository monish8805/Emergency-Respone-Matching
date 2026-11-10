import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  REQUEST_STATUSES,
  RESOURCE_STATUSES,
  RESOURCE_TYPES,
  createRequest,
  listRequests,
  listResources,
  registerResource,
  setRequestStatus,
  setResourceStatus,
  triggerMatch,
  type RequestStatus,
  type ResourceStatus,
  type ResourceType,
} from "../api";

export const Route = createFileRoute("/")({ component: Home });

const POLL_MS = 3000;

function Home() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const requests = useQuery({ queryKey: ["requests"], queryFn: () => listRequests(), refetchInterval: POLL_MS });
  const resources = useQuery({ queryKey: ["resources"], queryFn: () => listResources(), refetchInterval: POLL_MS });

  // Every mutation refreshes both lists, since matching changes both.
  const options = (message?: string) => ({
    onSuccess: () => {
      setNotice(message ?? null);
      return queryClient.invalidateQueries();
    },
    onError: () => setNotice(null),
  });

  const submitRequest = useMutation({ mutationFn: createRequest, ...options("Request submitted") });
  const submitResource = useMutation({ mutationFn: registerResource, ...options("Resource registered") });
  const updateRequest = useMutation({ mutationFn: setRequestStatus, ...options() });
  const updateResource = useMutation({ mutationFn: setResourceStatus, ...options() });
  const match = useMutation({ mutationFn: triggerMatch, ...options("Match queued") });

  const error = [requests, resources, submitRequest, submitResource, updateRequest, updateResource, match]
    .map((q) => q.error)
    .find(Boolean);

  const requestList = requests.data ?? [];
  const resourceList = resources.data ?? [];

  const resourceLabel = (id: string | null) => {
    if (!id) return "—";
    const r = resourceList.find((x) => x.id === id);
    return r ? `${r.type} @ ${r.location} (${id.slice(0, 8)})` : id.slice(0, 8);
  };

  return (
    <main>
      <h1>Emergency Response Matching</h1>
      {error && <div className="banner error">{error.message}</div>}
      {notice && !error && <div className="banner ok">{notice}</div>}

      <div className="grid">
        <RequestForm onSubmit={(d) => submitRequest.mutateAsync({ data: d })} />
        <ResourceForm onSubmit={(d) => submitResource.mutateAsync({ data: d })} />
      </div>

      <section>
        <h2>Requests ({requestList.length})</h2>
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
                  {requests.isPending ? "Loading…" : "No requests yet."}
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
                    options={REQUEST_STATUSES}
                    onChange={(s) => updateRequest.mutate({ data: { id: r.id, status: s as RequestStatus } })}
                  />
                </td>
                <td>{resourceLabel(r.resourceId)}</td>
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
        <h2>Resources ({resourceList.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Location</th>
              <th>Status</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {resourceList.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  {resources.isPending ? "Loading…" : "No resources registered."}
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
                <td className="mono">{r.id.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function StatusSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <select className={`status ${value}`} value={value} onChange={(e) => onChange(e.target.value)}>
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
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="12.97, 77.59" required />
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
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="12.97, 77.59" required />
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
