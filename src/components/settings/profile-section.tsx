interface ProfileSectionProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

export function ProfileSection({ user }: ProfileSectionProps) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold text-sf-text-primary mb-4">Profile</h2>
      <div className="flex items-center gap-4">
        {user.image && (
          <img
            src={user.image}
            alt=""
            width={48}
            height={48}
            className="rounded-full"
          />
        )}
        <div>
          <p className="text-[15px] font-medium text-sf-text-primary">{user.name ?? 'Unknown'}</p>
          <p className="text-[13px] text-sf-text-secondary">{user.email ?? ''}</p>
        </div>
      </div>
    </section>
  );
}
