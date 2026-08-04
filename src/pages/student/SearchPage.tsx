import { Calendar, MessageCircle, Search as SearchIcon, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { StudentAvatar } from '../../components/student/StudentAvatar';
import {
  acceptFriendByUserId,
  openChatWithPeer,
  sendFriendRequest,
  unifiedSearch,
} from '../../lib/social';
import type { SearchResult } from '../../types/social';

type Tab = 'all' | 'students' | 'communities' | 'events';

const RECENT_KEY = 'avichian_recent_searches';

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(arr) ? arr.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecent(q: string) {
  const next = [q, ...loadRecent().filter((x) => x !== q)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [tab, setTab] = useState<Tab>((searchParams.get('type') as Tab) || 'all');
  const [department, setDepartment] = useState(searchParams.get('department') ?? '');
  const [year, setYear] = useState(searchParams.get('year') ?? '');
  const [sort, setSort] = useState<'az' | 'recent' | 'active'>(
    (searchParams.get('sort') as 'az' | 'recent' | 'active') || 'az',
  );
  const [students, setStudents] = useState<SearchResult[]>([]);
  const [communities, setCommunities] = useState<
    Array<{
      id: string;
      name: string;
      description: string;
      memberCount: number;
      coverUrl: string | null;
    }>
  >([]);
  const [events, setEvents] = useState<
    Array<{ id: string; title: string; startsAt: string; venue: string | null }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [recent, setRecent] = useState(loadRecent);

  useEffect(() => {
    setQuery(searchParams.get('q') ?? '');
  }, [searchParams]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        setLoading(true);
        setError('');
        const data = await unifiedSearch({
          q: query.trim(),
          type: tab,
          department: department.trim() || undefined,
          year: year ? Number(year) : undefined,
          sort,
        });
        setStudents(data.students ?? []);
        setCommunities(data.communities ?? []);
        setEvents(data.events ?? []);
        if (query.trim().length >= 2) {
          saveRecent(query.trim());
          setRecent(loadRecent());
        }
        const next: Record<string, string> = {};
        if (query.trim()) next.q = query.trim();
        if (tab !== 'all') next.type = tab;
        if (department.trim()) next.department = department.trim();
        if (year) next.year = year;
        if (sort !== 'az') next.sort = sort;
        setSearchParams(next, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
        setStudents([]);
        setCommunities([]);
        setEvents([]);
      } finally {
        setLoading(false);
      }
    }, 280);
    return () => window.clearTimeout(timer);
  }, [query, tab, department, year, sort, setSearchParams]);

  const depts = useMemo(() => {
    const s = new Set(students.map((x) => x.department).filter(Boolean));
    return Array.from(s).sort();
  }, [students]);

  async function handleAddFriend(userId: string) {
    try {
      setActionId(userId);
      setError('');
      await sendFriendRequest(userId);
      setStudents((prev) =>
        prev.map((item) =>
          item.id === userId ? { ...item, friendshipStatus: 'pending_outgoing' } : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send request');
    } finally {
      setActionId(null);
    }
  }

  async function handleAccept(userId: string) {
    try {
      setActionId(userId);
      await acceptFriendByUserId(userId);
      setStudents((prev) =>
        prev.map((item) =>
          item.id === userId ? { ...item, friendshipStatus: 'friends' } : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setActionId(null);
    }
  }

  async function handleMessage(userId: string) {
    try {
      setActionId(userId);
      const chat = await openChatWithPeer(userId);
      navigate(`/home/chat/${chat.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Friends only can message');
    } finally {
      setActionId(null);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'students', label: 'Students' },
    { id: 'communities', label: 'Communities' },
    { id: 'events', label: 'Events' },
  ];

  return (
    <div className="mx-auto w-full max-w-xl min-w-0 space-y-4">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-4 top-[2.65rem] text-slate-400" size={18} />
        <Input
          label="Search"
          placeholder="Name, reg no, department, community, event…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          className="!pl-11"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              tab === t.id
                ? 'bg-primary text-white shadow-float'
                : 'bg-slate-100 text-slate-600 hover:bg-primary/10 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="text-xs text-slate-500">
          Department
          <input
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            list="dept-list"
            placeholder="Any"
            className="mt-1 min-h-10 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <datalist id="dept-list">
            {depts.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label className="text-xs text-slate-500">
          Year
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="mt-1 min-h-10 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">Any</option>
            {[1, 2, 3, 4].map((y) => (
              <option key={y} value={y}>
                Year {y}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as 'az' | 'recent' | 'active')}
            className="mt-1 min-h-10 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="az">A–Z</option>
            <option value="recent">Recently joined</option>
            <option value="active">Most active</option>
          </select>
        </label>
      </div>

      {!query.trim() && recent.length ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Recent</p>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setQuery(r)}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <p className="break-anywhere text-sm text-error">{error}</p> : null}
      {loading ? <p className="text-sm text-slate-500">Searching…</p> : null}

      {(tab === 'all' || tab === 'students') && students.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Students</h2>
          {students.map((student) => {
            const isPending = student.friendshipStatus === 'pending_outgoing';
            const isFriend = student.friendshipStatus === 'friends';
            const isIncoming = student.friendshipStatus === 'pending_incoming';
            return (
              <div
                key={student.id}
                className="glass-card flex min-w-0 items-center gap-3 rounded-[24px] p-3 shadow-soft sm:p-4"
              >
                <Link to={`/home/user/${student.id}`} className="shrink-0">
                  <StudentAvatar name={student.name} photoUrl={student.profilePhotoUrl} />
                </Link>
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/home/user/${student.id}`}
                    className="font-semibold text-slate-900 hover:text-primary break-anywhere dark:text-white"
                  >
                    {student.name}
                  </Link>
                  <p className="text-xs text-slate-500 break-anywhere">
                    {student.regNo} · {student.department}
                    {student.year ? ` · Y${student.year}` : ''}
                    {student.online ? ' · Online' : ''}
                    {(student.mutualFriends ?? 0) > 0
                      ? ` · ${student.mutualFriends} mutual`
                      : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
                  {isFriend ? (
                    <>
                      <span className="text-xs font-medium text-success">Friends</span>
                      <Button
                        variant="secondary"
                        className="w-auto !min-h-9 px-3 py-1.5 text-xs"
                        loading={actionId === student.id}
                        onClick={() => void handleMessage(student.id)}
                      >
                        <MessageCircle size={14} className="mr-1" /> Message
                      </Button>
                    </>
                  ) : isPending ? (
                    <span className="text-xs font-medium text-slate-400">Requested</span>
                  ) : isIncoming ? (
                    <Button
                      className="w-auto !min-h-9 px-3 py-1.5 text-xs"
                      loading={actionId === student.id}
                      onClick={() => void handleAccept(student.id)}
                    >
                      Accept
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      className="w-auto !min-h-9 px-3 py-1.5 text-xs"
                      loading={actionId === student.id}
                      onClick={() => void handleAddFriend(student.id)}
                    >
                      Add friend
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {(tab === 'all' || tab === 'communities') && communities.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Communities</h2>
          {communities.map((c) => (
            <Link
              key={c.id}
              to={`/home/communities/${c.id}`}
              className="glass-card flex items-center gap-3 rounded-[24px] p-4 shadow-soft"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <UsersRound size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900 dark:text-white">{c.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {c.memberCount} members · {c.description || 'Community'}
                </p>
              </div>
            </Link>
          ))}
        </section>
      ) : null}

      {(tab === 'all' || tab === 'events') && events.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Events</h2>
          {events.map((e) => (
            <Link
              key={e.id}
              to="/home/events"
              className="glass-card flex items-center gap-3 rounded-[24px] p-4 shadow-soft"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
                <Calendar size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900 dark:text-white">{e.title}</p>
                <p className="truncate text-xs text-slate-500">
                  {new Date(e.startsAt).toLocaleString()}
                  {e.venue ? ` · ${e.venue}` : ''}
                </p>
              </div>
            </Link>
          ))}
        </section>
      ) : null}

      {!loading &&
      query.trim() &&
      !students.length &&
      !communities.length &&
      !events.length ? (
        <p className="text-sm text-slate-500">No results for “{query.trim()}”.</p>
      ) : null}
    </div>
  );
}
