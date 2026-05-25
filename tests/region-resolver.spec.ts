import { RegionResolver } from "../src/domain/services/RegionResolver";

describe("RegionResolver", () => {
  it.each([
    ["Av. Atlantica, Copacabana", "Zona Sul"],
    ["Rua Dias da Cruz, Meier", "Zona Norte"],
    ["Avenida das Americas, Barra da Tijuca", "Zona Oeste"],
    ["Rua da Assembleia, Centro", "Centro"],
    ["Nova Iguacu", "Baixada"],
    ["Icarai, Niteroi", "Niteroi"],
    ["Alcantara, Sao Goncalo", "Sao Goncalo"],
    ["Rua das Pedras, Buzios", "Regiao dos Lagos"],
    ["Petropolis", "Intermunicipal"],
  ])("resolves %s to %s", (address, expectedRegion) => {
    const resolver = new RegionResolver();

    expect(resolver.resolve(address)).toBe(expectedRegion);
  });
});
