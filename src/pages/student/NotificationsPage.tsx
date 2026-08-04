import {
  Bell,
  Calendar,
  Check,
  Heart,
  Megaphone,
  MessageCircle,
  Phone,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import {
  acceptFriendRequest,
  deleteNotification,
  fetchNotifications,
  markNotificationsRead,
  rejectFriendRequest,
} from '../../lib/social';
import { connectSocket } from '../../lib/socket';

interface Notif {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  isRead?: boolean;
  data?: {
    requestId?: string;
    userId?: string;
    senderName?: string;
    callId?: string;
  } | null;
}

const icons: Record<string, typeof Bell> = {
  FRIEND_REQUEST: UserPlus,
  FRIEND_ACCEPTED: UserPlus,
  POST_LIKE: Heart,
  COMMENT: MessageCircle,
  CALL_MISSED: Phone,
  CALL_INCOMING: Phone,
  EVENT: Calendar,
  ANNOUNCEMENT: Megaphone,
  MESSAGE: MessageCircle,
  EVENT_REMINDER: Calendar,
};

function dayBucket(iso: string): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startY = new Date(startToday);
  startY.setDate(startY.getDate() - 1);
  if (d >= startToday) return 'today';
  if (d >= startY) return 'yesterday';
  return 'earlier';
}

export function NotificationsPage() {
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const data = await fetchNotifications();
    setItems((data.items as Notif[]) ?? []);
    setUnread(data.unread ?? 0);
  }, []);

  useEffect(() => {
    load()
      .catch(() => setItems([]))
      .finally(() => setLoading(false));

    const socket = connectSocket();
    function onNew(n: Notif) {
      setItems((prev) => [n, ...prev.filter((x) => x.id !== n.id)]);
      setUnread((u) => u + 1);
    }
    function onDeleted(payload: { id: string }) {
      setItems((prev) => prev.filter((x) => x.id !== payload.id));
    }
    socket.on('notification', onNew);
    socket.on('notification:new', onNew);
    socket.on('notification:deleted', onDeleted);
    return () => {
      socket.off('notification', onNew);
      socket.off('notification:new', onNew);
      socket.off('notification:deleted', onDeleted);
    };
  }, [load]);

  const grouped = useMemo(() => {
    const g: Record<'today' | 'yesterday' | 'earlier', Notif[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const n of items) g[dayBucket(n.createdAt)].push(n);
    return g;
  }, [items]);

  async function markAll() {
    await markNotificationsRead();
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString(), isRead: true })));
    setUnread(0);
  }

  async function accept(n: Notif) {
    const requestId = n.data?.requestId;
    if (!requestId) return;
    try {
      setBusyId(n.id);
      setError('');
      await acceptFriendRequest(requestId);
      setItems((prev) => prev.filter((x) => x.id !== n.id));
      setUnread((u) => Math.max(0, u - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(n: Notif) {
    const requestId = n.data?.requestId;
    if (!requestId) return;
    try {
      setBusyId(n.id);
      setError('');
      await rejectFriendRequest(requestId);
      setItems((prev) => prev.filter((x) => x.id !== n.id));
      setUnread((u) => Math.max(0, u - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(n: Notif) {
    try {
      await deleteNotification(n.id);
      setItems((prev) => prev.filter((x) => x.id !== n.id));
    } catch {
      /* ignore */
    }
  }

  function renderGroup(label: string, list: Notif[]) {
    if (!list.length) return null;
    return (
      <section key={label} className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</h2>
        {list.map((n) => {
          const Icon = icons[n.type] ?? Bell;
          const isFriendReq = n.type === 'FRIEND_REQUEST' && n.data?.requestId;
          return (
            <div
              key={n.id}
              className={`glass-card flex gap-3 rounded-[22px] p-4 shadow-soft ${
                !n.readAt && !n.isRead ? 'ring-1 ring-primary/25' : ''
              }`}
            >
              <div className="rounded-2xl bg-primary/10 p-2 text-primary">
                <Icon size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900 dark:text-white">{n.title}</p>
                <p className="text-sm text-slate-500">{n.body}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
                {isFriendReq ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      className="!min-h-10 w-auto px-4 text-xs"
                      loading={busyId === n.id}
                      onClick={() => void accept(n)}
                    >
                      <Check size={14} className="mr-1" /> Accept
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="!min-h-10 w-auto px-4 text-xs"
                      loading={busyId === n.id}
                      onClick={() => void reject(n)}
                    >
                      <X size={14} className="mr-1" /> Reject
                    </Button>
                    {n.data?.userId ? (
                      <Link
                        to={`/home/user/${n.data.userId}`}
                        className="inline-flex items-center rounded-full px-3 py-2 text-xs font-medium text-primary"
                      >
                        View profile
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="touch-target shrink-0 rounded-xl text-slate-400 hover:bg-slate-100 hover:text-error dark:hover:bg-slate-800"
                aria-label="Delete"
                onClick={() => void remove(n)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </section>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-slate-500">
            Friends, messages, calls, events{unread ? ` · ${unread} unread` : ''}
          </p>
        </div>
        {items.length ? (
          <Button type="button" variant="secondary" className="!min-h-10 w-auto px-3 text-xs" onClick={() => void markAll()}>
            Mark all read
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-error">{error}</p> : null}

      {loading ? (
        <div className="h-28 animate-pulse rounded-[24px] bg-slate-100 dark:bg-slate-800" />
      ) : items.length === 0 ? (
        <div className="glass-card rounded-[28px] p-8 text-center text-slate-400 shadow-soft">
          You&apos;re all caught up
        </div>
      ) : (
        <div className="space-y-5">
          {renderGroup('Today', grouped.today)}
          {renderGroup('Yesterday', grouped.yesterday)}
          {renderGroup('Earlier', grouped.earlier)}
        </div>
      )}

      <Link to="/home/friends" className="block text-center text-sm font-medium text-primary">
        Manage friend requests →
      </Link>
    </div>
  );
}
