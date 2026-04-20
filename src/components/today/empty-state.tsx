export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 animate-sf-fade-in">
      <div className="w-16 h-16 rounded-full bg-sf-bg-secondary flex items-center justify-center mb-6">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sf-text-tertiary"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>

      <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-2">
        No tasks today.
      </h2>

      <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-4 text-center max-w-sm leading-[1.47]">
        Your marketing team is scanning for opportunities. Check back later or create content manually.
      </p>
    </div>
  );
}
