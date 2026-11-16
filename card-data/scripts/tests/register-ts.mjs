/**
 * Hook de résolution pour les tests Node (`node --experimental-strip-types --import …`) :
 * les modules de src/lib s'importent sans extension (`./progress`), comme dans l'app (Metro) ;
 * Node exige l'extension, on la complète ici (`.ts`, puis `/index.ts`).
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (!relative || /\.[cm]?[jt]s$/.test(specifier)) throw error;
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // essai suivant
        }
      }
      throw error;
    }
  },
});
