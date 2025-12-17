import React from 'react';

export interface IconProps {
  className?: string;
}

const WifiIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    className={className}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M8.288 15.712a5 5 0 0 1 7.424 0M5.1 12.524c3.9-3.9 9.9-3.9 13.8 0M2.222 9.646c5.49-5.49 14.066-5.49 19.556 0"
    />
    <path
      fill="currentColor"
      d="M12 18.75a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 0 1 3.5 0Z"
    />
  </svg>
);

export default WifiIcon;