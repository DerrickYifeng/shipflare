interface Props {
  size?: number;
  color?: string;
}

export const CheckIcon: React.FC<Props> = ({
  size = 32,
  color = "var(--sf-success)",
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M8 12.5l3 3 5-6" />
  </svg>
);
