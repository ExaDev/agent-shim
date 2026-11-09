/**
 * How many report children the door runs at once, of any kind and for any report (`doctor`, or `check` for any path): a child is a whole process and may run probe workers of its own, so the bound keeps what a burst of requests costs to a fixed number of them. Requests beyond it wait for a child to end, in the order they came. Kept apart from both users, which would otherwise import each other: the probe derives from it the share of the reserved source ports each child's probes may hold.
 */
export const MAX_REPORT_CHILDREN = 2;
