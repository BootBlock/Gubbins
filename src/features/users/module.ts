/**
 * Whether the users module is switched on (issue #79, plan §3).
 *
 * One function, in one file, because it is the switch the whole feature hangs off: with it
 * **off** Gubbins behaves exactly as it always has — no sign-in, no permission ever refused,
 * every action attributed to the built-in Admin — and the user never meets the concept.
 *
 * It returns `false` unconditionally for now. The module's feature-registry entry, its
 * `/users` route and the admin screen that lets anyone create an account all arrive together
 * in phase 4; turning enforcement on before there is any way to administer accounts would
 * offer a door with no key cut for it. When that phase lands, this reads the modules store and
 * nothing else changes — every consumer already asks the question here.
 */
export function usersModuleEnabled(): boolean {
  return false;
}
