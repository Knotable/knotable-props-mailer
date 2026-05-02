export type NavItem = {
  label: string;
  href: string;
  description: string;
};

export const dashboardNav: NavItem[] = [
  {
    label: "Composer",
    href: "/email/composer",
    description: "Write and preview emails before sending",
  },
  {
    label: "Drafts / Queue",
    href: "/email/schedule",
    description: "Queue drafts, review them, and send each one manually",
  },
  {
    label: "Past Sends",
    href: "/email/sends",
    description: "View sent emails, delivery stats, and previews",
  },
  {
    label: "Monitor",
    href: "/email/monitor",
    description: "Drain a large queued campaign safely",
  },
  {
    label: "Analytics",
    href: "/email/analytics",
    description: "Track opens, clicks, and deliverability",
  },
  {
    label: "Lists",
    href: "/lists",
    description: "Manage mailing lists and imports",
  },
  {
    label: "Users",
    href: "/users",
    description: "Platform admin controls",
  },
];
