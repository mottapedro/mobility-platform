const REGION_RULES: Array<{ region: string; patterns: string[] }> = [
  {
    region: "Zona Sul",
    patterns: ["copacabana", "ipanema", "leblon", "botafogo", "flamengo", "lagoa", "gavea", "jardim botanico"],
  },
  {
    region: "Zona Oeste",
    patterns: ["barra da tijuca", "recreio", "jacarepagua", "campo grande", "bangu", "santa cruz", "guaratiba"],
  },
  {
    region: "Zona Norte",
    patterns: ["meier", "tijuca", "madureira", "vila isabel", "ilha do governador", "penha", "del castilho"],
  },
  {
    region: "Centro",
    patterns: ["centro", "lapa", "cinelandia", "candelaria", "praca xv", "praça xv"],
  },
  {
    region: "Baixada",
    patterns: ["nova iguacu", "nova iguaçu", "duque de caxias", "sao joao de meriti", "são joão de meriti", "belford roxo", "nilopolis", "nilópolis"],
  },
  {
    region: "Niteroi",
    patterns: ["niteroi", "niterói", "icarai", "icarai"],
  },
  {
    region: "Sao Goncalo",
    patterns: ["sao goncalo", "são gonçalo", "alcantara", "alcântara"],
  },
  {
    region: "Regiao dos Lagos",
    patterns: ["cabo frio", "buzios", "búzios", "armacao dos buzios", "armação dos búzios", "arraial do cabo", "saquarema", "rio das ostras"],
  },
  {
    region: "Intermunicipal",
    patterns: ["petropolis", "petrópolis", "teresopolis", "teresópolis", "nova friburgo", "itaborai", "itaboraí"],
  },
];

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export class RegionResolver {
  resolve(address: string): string {
    const normalizedAddress = normalizeText(address);

    for (const rule of REGION_RULES) {
      if (rule.patterns.some((pattern) => normalizedAddress.includes(normalizeText(pattern)))) {
        return rule.region;
      }
    }

    return "Intermunicipal";
  }
}
