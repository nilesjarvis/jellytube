import type { JellyfinItem, JellyfinPerson } from './types';

export function actorsForItem(item: JellyfinItem): JellyfinPerson[] {
  const actors: JellyfinPerson[] = [];
  const people = item.People;
  if (!people) return actors;

  const seenIds = new Set<string>();
  for (let index = 0; index < people.length; index += 1) {
    const person = people[index];
    if (person.Type !== 'Actor' || !person.Id || !person.Name || seenIds.has(person.Id)) continue;
    seenIds.add(person.Id);
    actors.push(person);
  }

  return actors;
}
