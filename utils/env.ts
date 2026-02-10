
const ENV_PREFIX = 'DP_';
export const envNumber = (name: string, defaults: number) =>
    Deno.env.get(ENV_PREFIX + name)?.match(/^[0-9\.]+$/)
        ? parseFloat(Deno.env.get(ENV_PREFIX + name)!)
        : defaults;

export const envString = (name: string, defaults: string) =>
    Deno.env.has(ENV_PREFIX + name) ? Deno.env.get(ENV_PREFIX + name)! : defaults;
