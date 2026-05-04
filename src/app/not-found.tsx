import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center bg-sf-bg-primary">
      <p className="text-[12px] tracking-[-0.12px] font-mono text-sf-text-tertiary uppercase mb-2">
        404
      </p>
      <h1 className="text-[21px] font-semibold text-sf-text-primary tracking-[0.231px] leading-[1.19] mb-2">
        Page not found
      </h1>
      <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary max-w-[360px] mb-6 leading-[1.47]">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
      <Link
        href="/briefing"
        className="
          inline-flex items-center justify-center
          min-h-[44px] px-[15px] py-2
          rounded-[var(--radius-sf-md)]
          bg-sf-accent text-white
          text-[17px] tracking-[-0.374px]
          hover:bg-sf-accent-hover transition-colors duration-200
        "
      >
        Go to Briefing
      </Link>
    </div>
  );
}
