import { SessionsPage } from "@/components/SessionsPage";
import { hasDashboardSession } from "@/lib/auth";

type Props = {
  searchParams: Promise<{ error?: string }>;
};

export default async function HomePage({ searchParams }: Props) {
  if (!(await hasDashboardSession())) {
    const { error } = await searchParams;
    return (
      <main className="shell">
        <form className="card" method="post" action="/api/login">
          <h1>Prostar</h1>
          <p className="muted">Enter your password to manage active sessions.</p>
          <input type="hidden" name="next" value="/" />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoFocus
          />
          <button type="submit">Continue</button>
          {error ? <p className="err">Incorrect password</p> : null}
        </form>
      </main>
    );
  }
  return <SessionsPage />;
}
