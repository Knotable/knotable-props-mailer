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
    label: "Schedule",
    href: "/email/schedule",
    description: "Queue, pause, or cancel scheduled sends",
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
