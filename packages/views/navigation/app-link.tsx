"use client";

import { forwardRef } from "react";
import { useNavigation } from "./context";

interface AppLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(
  function AppLink(
    { href, children, onClick, onMouseEnter, onFocus, ...props },
    ref,
  ) {
    const { push, openInNewTab, prefetch } = useNavigation();

    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        if (openInNewTab) {
          e.preventDefault();
          openInNewTab(href);
        }
        return;
      }
      e.preventDefault();
      onClick?.(e);
      push(href);
    };

    const handleMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
      prefetch?.(href);
      onMouseEnter?.(e);
    };

    const handleFocus = (e: React.FocusEvent<HTMLAnchorElement>) => {
      prefetch?.(href);
      onFocus?.(e);
    };

    return (
      <a
        ref={ref}
        href={href}
        {...props}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onFocus={handleFocus}
      >
        {children}
      </a>
    );
  },
);
